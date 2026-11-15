#!/bin/bash
# ZCode Bridge — account wizard
# Adds a Z.ai account (with its own plan, e.g. the 500M weekend plan) to the bridge.
# Usage: ./add-account.sh <account-id>   e.g. ./add-account.sh pc-learn7
set -e
BASE="$(cd "$(dirname "$0")" && pwd)"
ID="${1:-}"
if [ -z "$ID" ]; then
  echo "Usage: $0 <account-id>  (e.g. pc-learn7, second-account, work-account)"
  exit 1
fi
CLI="$BASE/zcode-cli-dist/zcode.cjs"
if [ ! -f "$CLI" ]; then
  echo "ERROR: CLI not built. Run $BASE/build-cli.sh first."
  exit 1
fi
PY="$(command -v python3)"
ACC="$BASE/accounts/$ID"
mkdir -p "$ACC/workspace" "$ACC/.zcode/v2"

# 1) per-account credential secret (no Keychain prompt in headless use)
if [ ! -f "$ACC/.credential-secret" ]; then
  python3 -c "import secrets,pathlib; p=pathlib.Path('$ACC/.credential-secret'); p.write_text(secrets.token_hex(32)); p.chmod(0o600)"
fi
SECRET=$(cat "$ACC/.credential-secret")

# 2) runtime config files
cat > "$ACC/.zcode/v2/settings.json" <<'EOF'
{"providerFamilyConnectionSelections": {"zai": {"kind": "start-plan"}}}
EOF
python3 - "$ACC" <<'PYEOF'
import json,sys,pathlib
acc=pathlib.Path(sys.argv[1])
p=acc/'.zcode/v2/provider_config.json'
if not p.exists():
    p.write_text(json.dumps({"schemaVersion":1,"config":{
        "providerOrder":[],
        "providerConfigRules":{"providerRules":[]},
        "modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]},
        "defaultModelSelection":{"providerId":"account:zai-start-plan","modelId":"GLM-5.3-Flash"},
    }},ensure_ascii=False,indent=1))
PYEOF

echo "=== Adding ZCode account: $ID ==="
echo "Step 1/3 — login. Open the URL below in a browser, sign in with the"
echo "Z.ai account for this profile and approve."
echo
HOME="$ACC" USERPROFILE="$ACC" ZCODE_DATA_BASE_DIR="$ACC" \
  ZCODE_CREDENTIAL_SECRET="$SECRET" \
  node "$CLI" login zai --no-browser
echo
echo "Step 2/3 — registering Start Plan identity for this account..."
python3 - "$ACC" <<'PYEOF'
import json,base64,hashlib,secrets,pathlib,sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
acc=pathlib.Path(sys.argv[1])
secret=(acc/'.credential-secret').read_text().strip()
key=hashlib.sha256(secret.encode()).digest()
fp=hashlib.sha256(key).hexdigest()[:24]
def seal(value):
    iv=secrets.token_bytes(12)
    ct=AESGCM(key).encrypt(iv, value.encode(), None)
    tag=ct[-16:]; body=ct[:-16]
    b=lambda x: base64.urlsafe_b64encode(x).decode().rstrip('=')
    return f"{b(iv)}.{b(tag)}.{b(body)}"
def entry(v): return f"enc:v2:env:{fp}:{seal(v)}"
# user id comes from the userinfo the CLI stored; decrypt it
creds=json.load(open(acc/'.zcode/v2/credentials.json'))
def openval(v):
    parts=v.split(':')
    payload=parts[4].split('.')
    b=lambda x: base64.urlsafe_b64decode(x+'='*(-len(x)%4))
    iv,tag,ct=b(payload[0]),b(payload[1]),b(payload[2])
    return AESGCM(key).decrypt(iv, ct+tag, None).decode()
userinfo=json.loads(openval(creds['oauth:zai:user_info']))
uid=userinfo.get('id') or userinfo.get('user_id')
creds['account-provider:account:zai-start-plan:identity']=entry(uid)
creds['account-provider:account:zai-start-plan:auth-source']=entry('oauth')
json.dump(creds,open(acc/'.zcode/v2/credentials.json','w'))
print('identity registered:', uid)
PYEOF
echo
echo "Step 3/3 — verification prompt (consumes a bit of the plan)..."
HOME="$ACC" USERPROFILE="$ACC" ZCODE_DATA_BASE_DIR="$ACC" \
  ZCODE_CREDENTIAL_SECRET="$SECRET" \
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$ACC/.zcode/v2/provider_config.json" \
  node "$CLI" --prompt 'فقط دقیقا کلمه OK را بنویس' --output-format stream-json \
  --no-color --cwd "$ACC/workspace" 2>&1 | grep '"type":"result"\|"type": "result"' | tail -1
echo
echo "Extracting official system prompt from the verification run..."
python3 - "$ACC" "$BASE" <<'PYEOF2'
import json,glob,sys,os
acc, base = sys.argv[1], sys.argv[2]
rolls = sorted(glob.glob(acc+'/.zcode/cli/rollout/model-io-*.jsonl'), key=os.path.getmtime)
if not rolls:
    raise SystemExit('no rollout found')
d = json.loads(open(rolls[-1]).read().strip().split('\n')[0])
sysb = d['request']['body']['system']
json.dump(sysb, open(base+'/zcode-system.json','w'), ensure_ascii=False)
print('zcode-system.json saved:', len(sysb), 'blocks,', sum(len(b["text"]) for b in sysb), 'chars')
PYEOF2
echo
echo "✅ Account '$ID' ready. The bridge will round-robin across all accounts."
