// The onion gate's refusal (gateway-transport.js): an `.onion` URL the
// session would not route through a proxy is refused before its request
// exists. Only the gate makes one, so an instance is evidence, made here
// in main, that no byte of that request was sent. An error's text never
// is: anything can say ".onion gateway" (freedom-core design 0005,
// `not_sent`).
class OnionGateRefusal extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'OnionGateRefusal';
  }
}

module.exports = { OnionGateRefusal };
