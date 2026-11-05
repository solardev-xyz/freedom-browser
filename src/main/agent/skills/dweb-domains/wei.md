# WNS .wei

This is the independent WNS NameNFT namespace on Ethereum, not ENS .eth.
Registration mints to the actual paying wallet. Commit/reveal use separate wallet
approvals and an on-chain age check. Initial registration and each renewal add
exactly 365 days; do not promise an arbitrary duration or batch extra payments.

Quote the current fee by UTF-8 byte length plus any registration premium. WNS
fees are configurable; never quote old README values. Expiry/grace and the actual
contract decide availability. ERC721 operator approval does not authorize record
edits: the active token owner is required.

WNS lowercases ASCII only. Freedom refuses ambiguous legacy Unicode inputs whose
registered bytes differ from its conservative normalized policy. Do not silently
substitute another name. Parent/subname lifecycle and re-registration epochs are
distinct from ENS. Subname registration and registrar storefronts remain outside
the initial direct tools. Ordinary website/address/text changes preserve all
other records.
