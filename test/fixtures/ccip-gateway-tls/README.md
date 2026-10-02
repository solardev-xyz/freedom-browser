# CCIP gateway TLS fixture

`ccip-gateway-test.{crt,key}` is a throwaway self-signed P-256 certificate for
the HTTPS origin in
`src/main/__tests__/integration/ccip-proxy-electron-probe.js` (SANs
`ccip.example.test` and `ccipgatewayprobe.onion`, valid for 100 years). It
guards nothing: the probe trusts it only inside its own Electron process, via
`setCertificateVerifyProc` for exactly those two names. It lives outside `src/` so
packaged builds never contain it.

Regenerate with:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
  -subj "/CN=ccip.example.test" \
  -addext "subjectAltName=DNS:ccip.example.test,DNS:ccipgatewayprobe.onion" \
  -keyout ccip-gateway-test.key -out ccip-gateway-test.crt
```
