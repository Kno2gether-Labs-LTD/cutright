// Reading Gatekeeper's verdict, correctly.
//
// `spctl -a -vv` answers in three lines, and the words overlap in a way that punishes a lazy
// match: a build that is NOT notarised reports "source=Unnotarized Developer ID", which contains
// the substring "notarized". Testing for /Notarized/i therefore reports every signed build as
// notarised — including one Gatekeeper is actively rejecting. About is where somebody goes to ask
// "is this the real thing"; answering that wrongly is worse than not answering.
export function parseSpctl(text) {
  const s = String(text || '');
  const accepted = /:\s*accepted/i.test(s);
  const rejected = /:\s*rejected/i.test(s);
  // The "Un" prefix is the whole game. Match the source line as a unit, not a word inside it.
  const unnotarized = /source=\s*Unnotarized/i.test(s);
  const notarized = !unnotarized && /source=\s*Notarized/i.test(s);
  const origin = (s.match(/^origin=(.+)$/m) || [])[1]?.trim() || null;
  return {
    accepted, rejected, notarized, origin,
    // What a person actually wants to know, in words.
    plain: notarized && accepted ? 'yes — Apple has checked this build'
      : unnotarized ? 'no — signed, but Apple has not checked it, so a downloaded copy will be blocked'
      : accepted ? 'accepted by macOS'
      : rejected ? 'macOS would refuse to open a downloaded copy'
      : 'unknown',
  };
}
