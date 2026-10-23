# ENS .eth

Freedom's initial direct adapter supports the pinned ENSv1 mainnet registrar and
current public resolver. Deployed v2 contracts do not imply v2 registration is
active or supported. Changed versions/controllers are refused, not guessed.

Only top-level .eth registration/renewal is supported. Normalize with ENSIP-15;
Freedom checks contract validity and minimum duration. Default term is 31,536,000
seconds (365 days); quote exact seconds, price and network fees. Current tuple
registration creates an unwrapped name, owned by the selected wallet, with no
primary-name change. Commit/reveal have separate approvals and a chain-time wait.

Existing names use their actual resolver. Only qualified public-resolver writes
are supported; an owner, manager or authorized resolver delegate must be allowed
by the contract. Wrapped renewal follows its own controller and preserves wrapper
expiry/ownership; unavailable qualification must be reported rather than renewed
through the wrong controller. Do not automatically wrap, burn fuses, migrate a
resolver or buy through a marketplace.

set_website uses a verified Swarm publication; set_address changes only the ETH
address; set_text changes one explicit key. Other records stay untouched.
