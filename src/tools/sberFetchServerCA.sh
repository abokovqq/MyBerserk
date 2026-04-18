#!/usr/bin/env bash
set -euo pipefail

LEAF="${1:-/tmp/sber_srv_01.pem}"
OUT="${2:-/home/a/abokovsa/berserkclub.ru/MyBerserk/certs/sber-server-ca-bundle.pem}"

mkdir -p "$(dirname "$OUT")"

if [[ ! -f "$LEAF" ]]; then
  echo "ERROR: leaf cert not found: $LEAF" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

extract_aia_uris() {
  local cert="$1"
  openssl x509 -in "$cert" -noout -text \
    | awk '/CA Issuers - URI:/{print $0}' \
    | sed -E 's/.*CA Issuers - URI: *//'
}

to_pem() {
  local in="$1"
  local out="$2"
  # пробуем как PEM, если не получилось — как DER
  if openssl x509 -in "$in" -noout >/dev/null 2>&1; then
    openssl x509 -in "$in" -out "$out" >/dev/null
    return 0
  fi
  openssl x509 -inform DER -in "$in" -out "$out" >/dev/null
}

download_first_working() {
  local uris=("$@")
  local raw="$tmp/ca.raw"
  for u in "${uris[@]}"; do
    [[ -z "$u" ]] && continue
    echo "Trying: $u"
    if curl -fsSL "$u" -o "$raw"; then
      echo "$raw"
      return 0
    fi
  done
  return 1
}

cert_subject() { openssl x509 -in "$1" -noout -subject | sed -E 's/^subject= *//'; }
cert_issuer()  { openssl x509 -in "$1" -noout -issuer  | sed -E 's/^issuer= *//'; }

echo "LEAF: $LEAF"
echo "OUT : $OUT"
echo ""

# 1) issuer для leaf
mapfile -t uris1 < <(extract_aia_uris "$LEAF")
if [[ "${#uris1[@]}" -eq 0 ]]; then
  echo "ERROR: no CA Issuers URIs found in LEAF AIA" >&2
  exit 3
fi

raw1="$(download_first_working "${uris1[@]}")" || {
  echo "ERROR: could not download issuer cert from any AIA URI" >&2
  exit 4
}

pem1="$tmp/issuer1.pem"
to_pem "$raw1" "$pem1"

sub1="$(cert_subject "$pem1")"
iss1="$(cert_issuer "$pem1")"

echo "Issuer #1 subject: $sub1"
echo "Issuer #1 issuer : $iss1"
echo ""

# собираем bundle
cat "$pem1" > "$OUT"

# 2) если issuer1 НЕ self-signed — докачаем родителя issuer2
if [[ "$sub1" != "$iss1" ]]; then
  echo "Issuer #1 is not self-signed. Fetching parent CA..."
  mapfile -t uris2 < <(extract_aia_uris "$pem1")
  if [[ "${#uris2[@]}" -eq 0 ]]; then
    echo "WARN: no AIA URIs found in Issuer #1; cannot auto-fetch parent." >&2
  else
    raw2="$(download_first_working "${uris2[@]}")" || {
      echo "WARN: could not download parent CA from Issuer #1 AIA." >&2
      raw2=""
    }
    if [[ -n "${raw2:-}" ]]; then
      pem2="$tmp/issuer2.pem"
      to_pem "$raw2" "$pem2"
      sub2="$(cert_subject "$pem2")"
      iss2="$(cert_issuer "$pem2")"
      echo "Issuer #2 subject: $sub2"
      echo "Issuer #2 issuer : $iss2"
      echo ""
      cat "$pem2" >> "$OUT"
    fi
  fi
fi

echo "Saved CA bundle: $OUT"
echo ""

echo "Verifying leaf with bundle..."
openssl verify -CAfile "$OUT" "$LEAF" || {
  echo ""
  echo "ERROR: openssl verify failed. Bundle may be incomplete." >&2
  exit 5
}

echo ""
echo "OK: openssl verify succeeded."