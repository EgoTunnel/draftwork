// Approved RFC 3161 timestamp services, pinned by the SHA-256 of a CA's public key (SubjectPublicKeyInfo).
// A token is trusted when its signer chains, by verified signatures, to one of these keys.
// Public keys survive certificate renewals and cross-signing, unlike certificate fingerprints.
export const TRUST_ANCHORS = [
  { name: 'FreeTSA', url: 'https://freetsa.org/tsr', spki: '52c54ba340885605314daa1857c8763b94087d05c636092938d4e2d1818e99b5' },
  { name: 'DigiCert Trusted Root G4', url: 'http://timestamp.digicert.com', spki: '59df317bfa9f4f0ab7ca514d7772296aa2c765b87664d08b96e57399e364729c' },
  { name: 'Sectigo Public Time Stamping Root R46', url: 'http://timestamp.sectigo.com', spki: 'a4db8668c6796ebf476ddc5ace453a9260dbd4dbb09f51ecec9a839003824795' },
  { name: 'GlobalSign Timestamping Root R45', url: 'http://rfc3161timestamp.globalsign.com/advanced', spki: '16b0d55042a7d9ceb2f1204aa64c65b3a9046e9ecf1bef5421f3d2be1bc5ffac' },
  { name: 'SSL.com Timestamping Issuing RSA CA R1', url: 'http://ts.ssl.com', spki: '4a25ba3fade1c4aca4ee4ca968eceebba567eca8bb51724266390bb4521c3c21' },
];

// Anchors for an assignment: the built-in list plus any the instructor added.
export function anchorsFor(config) {
  const extra = (config && config.tsa_anchors) || [];
  return [...TRUST_ANCHORS, ...extra.filter((a) => /^[0-9a-f]{64}$/.test(a.spki))];
}
