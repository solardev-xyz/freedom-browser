/**
 * Chromium hides host ICE candidates behind mDNS names by default; two
 * local browser stacks on a CI runner cannot always resolve each other's
 * .local names, and there is no external STUN in the offline tests.
 * Shared by the remote-signing E2E and the iOS openlv harness so the
 * workaround can't drift between them.
 */

const WEBRTC_LOCAL_SWITCH = '--disable-features=WebRtcHideLocalIpsWithMdns';

module.exports = { WEBRTC_LOCAL_SWITCH };
