# GNS .gwei

This is the independent GNS NameNFT namespace on Ethereum, not WNS or ENS.
Use its own contract, fresh commitment secret and current quote. Registration
mints to the paying wallet after separately approved commit/reveal transactions.
Each registration/renewal term is 365 days. Never reuse a WNS commitment merely
because the ABIs resemble one another.

Quote UTF-8 byte-length fee plus current registration premium on chain. Active
token ownership, expiry and parent epochs control record writes. ERC721 operator
approval is not resolver-edit authority. ASCII-only lowercase normalization must
not change legacy Unicode bytes; unsupported spellings need the management app.

GNS's inherited upstream audits are not a separate audit of GNS-specific changes.
No cryptographic/trust badge is implied. Passport claims, subdomain storefronts,
escrow, arbitrary transfers and bulk buying are outside these initial tools.
Website/address/text changes affect only the explicit requested record.
