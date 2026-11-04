#!/usr/bin/env bash
# lan-certs.sh — the certificates behind `pnpm sandbox:full --lan` (HTTPS on the local network).
#
#   bash lan-certs.sh <ca-dir> <out-dir> <lan-ipv4>
#
# <ca-dir>   the sandbox's own certificate authority, made ONCE and kept outside every git work tree
#            (full.sh: ~/.config/usrp/sandbox-ca). Each phone, tablet or browser trusts ca.crt once; the
#            CA outlives .sandbox/ so a reset does not mean re-trusting every device.
# <out-dir>  the server certificate for this address (full.sh: .sandbox/tls). Reissued whenever the
#            address changes, the certificate is within 30 days of expiry, or it no longer verifies
#            against the CA.
#
# The CA is NAME-CONSTRAINED: it can only ever vouch for private addresses (10/8, 172.16/12, 192.168/16,
# 100.64/10, 127/8) and `localhost`. A device that trusts it therefore trusts nothing on the internet,
# even if ca.key leaks. The server certificate stays within what phones accept for a locally trusted CA:
# P-256, SHA-256, subjectAltName, serverAuth, 397 days (Apple's limit is 398).
#
# Prints the CA's SHA-256 fingerprint, the value to compare on a device before trusting it.
set -euo pipefail
CA_DIR="$1"; OUT="$2"; IP="$3"
[[ "$IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo "✗ not an IPv4 address: $IP" >&2; exit 2; }
command -v openssl >/dev/null || { echo "✗ openssl is required for --lan" >&2; exit 2; }
umask 077
mkdir -p "$CA_DIR" "$OUT"; chmod 700 "$CA_DIR" "$OUT"

if [ ! -s "$CA_DIR/ca.key" ] || [ ! -s "$CA_DIR/ca.crt" ]; then
  cat > "$CA_DIR/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = ca_ext
[dn]
O = USRP sandbox (local, not a public CA)
CN = USRP sandbox local CA
[ca_ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0, permitted;IP:100.64.0.0/255.192.0.0, permitted;IP:127.0.0.0/255.0.0.0, permitted;DNS:localhost
EOF
  openssl ecparam -name prime256v1 -genkey -noout -out "$CA_DIR/ca.key" 2>/dev/null
  openssl req -new -x509 -sha256 -days 1825 -key "$CA_DIR/ca.key" -config "$CA_DIR/ca.cnf" \
    -subj "/O=USRP sandbox (local, not a public CA)/CN=USRP sandbox local CA ($(hostname -s 2>/dev/null || echo host))" \
    -out "$CA_DIR/ca.crt" 2>/dev/null
  chmod 600 "$CA_DIR/ca.key"; chmod 644 "$CA_DIR/ca.crt"
  echo "created the sandbox CA in $CA_DIR (trust ca.crt once on each device)" >&2
fi

fresh() {
  [ -s "$OUT/server.crt" ] && [ -s "$OUT/server.key" ] && [ "$(cat "$OUT/address" 2>/dev/null)" = "$IP" ] \
    && openssl x509 -in "$OUT/server.crt" -noout -checkend $((30 * 86400)) >/dev/null 2>&1 \
    && openssl verify -CAfile "$CA_DIR/ca.crt" "$OUT/server.crt" >/dev/null 2>&1
}
if ! fresh; then
  cat > "$OUT/server.cnf" <<EOF
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
subjectAltName = IP:$IP, IP:127.0.0.1, DNS:localhost
EOF
  openssl ecparam -name prime256v1 -genkey -noout -out "$OUT/server.key" 2>/dev/null
  openssl req -new -sha256 -key "$OUT/server.key" -subj "/CN=$IP" -out "$OUT/server.csr" 2>/dev/null
  openssl x509 -req -sha256 -days 397 -in "$OUT/server.csr" -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -extfile "$OUT/server.cnf" -extensions ext -out "$OUT/server.crt" 2>/dev/null
  rm -f "$OUT/server.csr"
  openssl verify -CAfile "$CA_DIR/ca.crt" "$OUT/server.crt" >/dev/null \
    || { echo "✗ the server certificate for $IP does not verify against $CA_DIR/ca.crt" >&2; exit 1; }
  echo "$IP" > "$OUT/address"
fi
openssl x509 -in "$CA_DIR/ca.crt" -noout -fingerprint -sha256 | cut -d= -f2
