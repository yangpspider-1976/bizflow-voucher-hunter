# Deploying the SMPP worker

The SMSC whitelists **one client IP** and permits **one concurrent bind**. Vercel
egresses from a shared pool with a different address per invocation, so a bind
from the app is never answered — it times out with no error to read. The bind
therefore lives in `server/smpp-worker.cjs`, one process on one host holding the
whitelisted address, and the app relays to it over HTTP.

> Vercel does sell fixed egress addresses — Static IPs at $100/month per project,
> or dedicated IPs via Secure Compute on Enterprise. Either would remove the need
> for this host. Both cost more than an order of magnitude what the worker's VPS
> does, which is the only reason they were not chosen.

This document deploys that host. Artifacts live in [`deploy/smpp-worker/`](../../deploy/smpp-worker/).

> **A cellular uplink cannot hold this role.** A consumer 5G/LTE router draws a
> new address from the carrier pool on every re-registration, and is usually
> behind CGNAT besides — the whitelisted address is neither yours nor stable.
> The whole point of this host is an address that does not move.

## What you need first

- A VPS with a **dedicated static IPv4**, in or near the SMSC's region.
- A DNS name that will resolve to it. A free dynamic-DNS name is fine; the
  address is static, the name only has to exist for certificate issuance.
- The SMSC credentials, and a channel to your provider for the IP whitelist.

Values referenced below live in `deploy/smpp-worker/smpp-worker.env.example`.

---

## 1. Provision the VPS

Any provider with a dedicated static IP works. DigitalOcean, Vultr, and Linode
all have Singapore regions at roughly $5–6/month, which is the nearest region to
a Philippine aggregator.

Region matters beyond latency: the worker awaits each `submit_sm` response
before submitting the next part ([`smpp-worker.cjs`](../../server/smpp-worker.cjs)),
so round-trip time is a direct ceiling on throughput.

- **Size:** the smallest tier. This is one Node process holding one TCP session;
  1 GB RAM is generous.
- **Image:** Ubuntu 24.04 LTS.
- **IP:** confirm it is static and dedicated. Note it down.

> Free tiers were evaluated and rejected. Oracle Cloud Always Free is the only
> one offering a dedicated static IP, but it reclaims instances whose CPU stays
> below 20% over 7 days — and an SMPP worker is near-idle by design, so it would
> be stopped on a rolling basis with SMS failing silently each time. Avoiding
> that required a Pay-As-You-Go conversion, a home region fixed permanently at
> signup, and a second host-level firewall. The paid VPS removes all of it.

## 2. Get the IP whitelisted — start this now

Whitelisting has provider lead time and everything downstream is blocked on it,
so send the request as soon as you have the address. Ask for two things:

1. The new address whitelisted — and whether the previous entry should be
   **replaced or kept**, if another host still binds with these credentials.
2. Whether the account permits more than one whitelisted address, which is worth
   knowing before you ever need to migrate hosts.

Until this lands, TCP to the SMSC from the new host will hang with no response.
That silent timeout is the expected symptom, not a misconfiguration.

Verify once the provider confirms:

```bash
timeout 15 bash -c 'cat < /dev/null > /dev/tcp/<SMPP_HOST>/2775' && echo reachable || echo "no response"
```

## 3. Open the firewall

Allow inbound 443 and 80. Port 80 is needed only for the ACME HTTP challenge;
leave it open so certificates renew unattended.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

If your provider also has a cloud firewall in its control panel, the same two
ports must be open there — traffic has to pass both layers.

**Do not open 8080.** The worker binds `0.0.0.0:8080` and offers no way to bind
loopback only, so the firewall is the only thing keeping it off the internet.
Caddy reaches it over `127.0.0.1`, which `ufw` does not filter.

Outbound needs no rules on a default Ubuntu install; that is what carries the
SMPP session to port 2775.

## 4. Install Node and the worker

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

The worker needs only `node:http` and the `smpp` package — not Next, not the app
dependency tree. Deploy it standalone rather than cloning the repo; the install
is five packages and a few seconds.

From your workstation:

```bash
scp server/smpp-worker.cjs \
    deploy/smpp-worker/package.json \
    root@<PUBLIC_IP>:/tmp/
```

On the host:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin smppworker
sudo mkdir -p /opt/smpp-worker
sudo mv /tmp/smpp-worker.cjs /tmp/package.json /opt/smpp-worker/
cd /opt/smpp-worker && sudo npm install --omit=dev --no-audit --no-fund
sudo chown -R root:smppworker /opt/smpp-worker
sudo chmod -R o-rwx /opt/smpp-worker
```

Files stay root-owned and are only readable by the service account: the worker
never writes to its own directory.

> `deploy/smpp-worker/package.json` pins `smpp` separately from the root
> manifest. Bump both together — the worker's message segmentation is already
> hand-synchronised with `src/server/sms.ts` and pinned by
> `tests/unit/smpp-worker-parity.test.ts`; a version skew in the SMPP library
> would be a second, unpinned divergence.

## 5. Install the environment file

```bash
sudo install -o root -g root -m 600 \
  deploy/smpp-worker/smpp-worker.env.example /etc/smpp-worker.env
sudoedit /etc/smpp-worker.env
```

Fill in every `replace_with_` value. The worker refuses to start while any
required one still carries that prefix, so a half-filled file fails at boot with
the offending variable named rather than dialling a bogus host.

Two that are easy to get wrong:

- `SMPP_DLR_CALLBACK_URL` must point at the **production** app. This host cannot
  reach a dev server on your laptop, and delivery receipts arrive on the worker's
  session — if it cannot forward them, `sms_logs` never leaves `sent`.
- `SMPP_WORKER_API_TOKEN` and `SMPP_WORKER_CALLBACK_SECRET` are two different
  secrets guarding opposite directions of trust. Do not collapse them into one.

Mode `600` and root ownership are deliberate: the file holds SMSC credentials,
and anything in a systemd unit is world-readable via `systemctl cat`.

## 6. Start it under systemd

```bash
sudo install -o root -g root -m 644 \
  deploy/smpp-worker/smpp-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now smpp-worker
systemctl status smpp-worker
curl -s localhost:8080/health
```

Expect `{"ok":true,"bound":false}`. **`bound:false` is correct here** — the bind
is paid lazily on the first send, not at startup, so this only tells you the
process is alive.

## 7. Terminate TLS

The app sends its bearer token on every request. Over plain HTTP that token
crosses the internet in cleartext, and whoever holds it can spend your SMPP
credit.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Point your DNS name at the public IP, install the Caddyfile with the hostname
replaced, and reload:

```bash
sudo cp deploy/smpp-worker/Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile     # set your hostname
sudo systemctl reload caddy
curl -s https://<your-host>/health
```

Certificates are obtained and renewed automatically.

## 8. Point the app at the worker

Set these in **Vercel** (and any other hosted environment):

| Variable | Value |
| --- | --- |
| `SMS_PROVIDER` | `smpp_worker` |
| `SMPP_WORKER_URL` | `https://<your-host>` |
| `SMPP_WORKER_API_TOKEN` | same value as the worker's |
| `SMPP_WORKER_CALLBACK_SECRET` | same value as the worker's |
| `SMPP_WORKER_TIMEOUT_MS` | `20000` (optional) |

The app needs **none** of `SMPP_HOST`, `SMPP_SYSTEM_ID`, or `SMPP_PASSWORD` on
this path. Those belong only to the host that binds. Leaving SMSC credentials
out of the app's environment is one fewer place they can leak.

Locally, point `SMPP_WORKER_URL` in `.env` at the same HTTPS host and delete the
SMSC block — see the note on concurrent binds below before doing so.

## 9. Verify end to end

```bash
curl -X POST https://<your-host>/messages \
  -H "Authorization: Bearer $SMPP_WORKER_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"639171234567","message":"Voucher Hunt worker test"}'
```

Destination is international format without `+`, matching `dest_addr_ton=1`.

- `{"success":true,"provider_message_id":"..."}` — the bind succeeded and the
  message was accepted.
- `journalctl -u smpp-worker -f` should show `[SMPP worker] bound` on the first
  send, and `/health` should now report `"bound":true`.

Then exercise the real path: request a sign-in OTP in the app and confirm the
`sms_logs` row moves to delivered (`npm run sms:logs`).

---

## Operating notes

**One bind, account-wide.** Once this host is live it holds the only permitted
session. Running `npm run worker` on your laptop at the same time fails with
`ESME_ALREADYBOUND` — and if it wins the race instead, it takes production SMS
down. Use `SMS_PROVIDER=mock` for local development; OTP codes print to the dev
console and cost nothing.

**Rebinding is lazy.** On a dropped session the worker logs
`session closed; will rebind on next send` and reconnects on the *next* message,
which pays the bind latency inside that request. This is why the app-side
`SMPP_WORKER_TIMEOUT_MS` is generous.

**Logs.** `journalctl -u smpp-worker -f`. Failures worth recognising:
`ESME_RTHROTTLED` (over your TPS allowance or quota) and `ESME_RINVSRCADR`
(sender ID not registered for that carrier) are account-side, not code defects.

**Updating the worker.** `scp` the new `smpp-worker.cjs`, then
`sudo systemctl restart smpp-worker`. A restart drops the bind; the next send
re-establishes it. Re-run `npm run test -- smpp-worker-parity` first if the
segmentation logic changed.

**Keeping the host patched.** `sudo apt update && sudo apt upgrade` on a routine
you actually keep, and enable `unattended-upgrades` for security patches. This is
the one ongoing cost of owning the server rather than renting a platform.

**If SMS stops with no obvious cause,** check in this order: `systemctl status
smpp-worker` (crashed?), `/health` for bind state, then TCP reachability to the
SMSC — a whitelist that was silently dropped presents exactly like the original
problem, as a timeout with no response.
