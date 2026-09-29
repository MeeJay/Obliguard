import crypto from 'crypto';
import { promisify } from 'util';
import forge from 'node-forge';

/**
 * Fabrication du certificat d'authentification d'un tenant M365.
 *
 * Entra n'accepte qu'un certificat X.509 comme credential d'application, pas une
 * clé publique nue. Obliguard détient la clé privée, donc c'est Obliguard qui
 * fabrique et auto-signe ce certificat ; le script d'enrôlement ne téléverse que
 * la partie publique.
 *
 * Les clés sont produites par le crypto natif, qui est asynchrone et ne bloque
 * pas la boucle d'événements. node-forge n'intervient que pour l'encodage ASN.1
 * du certificat, ce que Node ne sait pas faire.
 */

const generateKeyPair = promisify(crypto.generateKeyPair);

/** Durée de vie du certificat. Au-delà, l'enrôlement doit être refait. */
const VALIDITY_YEARS = 2;
const MODULUS_LENGTH = 2048;

export interface GeneratedCertificate {
  /** Clé privée PKCS#8, PEM. À chiffrer avec encryptSecret avant stockage. */
  privateKeyPem: string;
  /** Certificat auto-signé, PEM. Matériel public, téléversé dans le tenant client. */
  certificatePem: string;
  /** Empreinte SHA-1 en hexadécimal majuscule, telle qu'Entra et le portail l'affichent. */
  thumbprint: string;
  /** Fin de validité, en ISO 8601. */
  notAfter: string;
}

/**
 * Produit une paire de clés et le certificat auto-signé correspondant.
 *
 * `subjectName` apparaît dans le sujet du certificat : il sert à reconnaître
 * l'entrée dans la liste des certificats de l'application côté portail Entra,
 * là où plusieurs credentials peuvent coexister pendant une rotation.
 */
export async function generateCertificate(subjectName: string): Promise<GeneratedCertificate> {
  const { privateKey, publicKey } = await generateKeyPair('rsa', {
    modulusLength: MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  // Numéro de série positif : un premier octet ≥ 0x80 serait lu comme un entier
  // négatif en DER, ce que certains validateurs refusent.
  cert.serialNumber = `00${crypto.randomBytes(16).toString('hex')}`;

  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  // Antidater légèrement absorbe les écarts d'horloge entre Obliguard et Entra.
  cert.validity.notBefore = new Date(notBefore.getTime() - 5 * 60 * 1000);
  cert.validity.notAfter = notAfter;

  const attrs = [{ name: 'commonName', value: subjectName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // auto-signé : sujet et émetteur sont identiques
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
  ]);

  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  return {
    privateKeyPem: privateKey,
    certificatePem: forge.pki.certificateToPem(cert),
    thumbprint: thumbprintOf(cert),
    notAfter: notAfter.toISOString(),
  };
}

/** Empreinte SHA-1 du certificat encodé en DER, ce qu'Entra attend dans `x5t`. */
function thumbprintOf(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.md.sha1.create().update(der).digest().toHex().toUpperCase();
}

/**
 * Renvoie le certificat sans ses en-têtes PEM ni ses retours à la ligne, forme
 * attendue par le champ `keyCredentials.key` de Graph et par le script d'enrôlement.
 */
export function certificateToBase64(certificatePem: string): string {
  return certificatePem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}
