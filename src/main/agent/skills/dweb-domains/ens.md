# ENS .eth

New .eth registrations use ENSv2 on Ethereum mainnet. Unmigrated v1 names renew
through the qualified legacy renewer; migrated/new names renew through the v2
registrar. Freedom chooses the route from chain state. Never use the retired v1
registration controller or replay an old v1 commitment against v2.

Inspect the exact normalized name and intended term first. ENS payments use USDC
by default; DAI can be requested with paymentToken. Network fees still require
ETH. Quote the actual token amount and separate ETH fees; never substitute ETH
for the token or exchange currencies without a separate user instruction.
Only top-level registration/renewal is supported. The default term is 365 days.

Register to the selected Freedom wallet. Commit spends network fees but does not
reserve or buy the name. Preserve the operationId through the chain-time wait.
Additional ready steps can approve a bounded token allowance and deploy the
wallet's official ENS records contract. Each requires a separate wallet approval;
none of them buys a name. The final reveal/register also requires approval.
Always continue the same operation ID; follow its returned state and step.
The token allowance is capped, never unlimited. A price decrease can leave unused
allowance; do not claim ENS refunds tokens or applies the legacy ETH price buffer.

New registrations use a qualified wallet-controlled permissioned resolver that
can be reused for later names. The setup approval explains its record permissions
and upgrade authority. Do not replace an existing name's custom resolver, migrate
an owned name, wrap, burn fuses or buy through a marketplace as a workaround.

Existing records use their actual qualified resolver and its authorization rules.
set_website needs a verified Swarm publication; set_address changes only the ETH
address; set_text changes one explicit key. Other records stay untouched.
Renewing extends expiry and preserves ownership/records. Grace/renewability comes
from the current contracts; never apply v1's old 90-day rule to v2 names.

Report completed ownership only after the final registration receipt and state
verification. Token approval, resolver setup, a commitment, or a ready reveal is
not a completed purchase. After Stop, decline or uncertainty, inspect the journal
and require the user's request before resuming; never buy a second commitment to
work around a failed setup step or an unclear broadcast.
