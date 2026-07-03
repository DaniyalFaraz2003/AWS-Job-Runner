import { createPrivateKey, createPublicKey } from "node:crypto";
import { ECTL_ERROR_CODES, EctlError } from "../types/errors.js";

function base64UrlToBuffer(value: string): Buffer {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function encodeSshString(value: string | Buffer): Buffer {
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function encodeSshMpint(value: Buffer): Buffer {
  let bytes = value;

  if (bytes.length > 0 && (bytes[0]! & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }

  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** Derive OpenSSH public key material from an RSA private key PEM (FR-INIT-6). */
export function derivePublicKeyMaterialFromPrivatePem(
  privateKeyPem: string,
): string {
  let publicKey;
  try {
    publicKey = createPublicKey(createPrivateKey(privateKeyPem));
  } catch (error) {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      "Invalid private key PEM. Provide an RSA key in PEM format.",
      error,
    );
  }

  const jwk = publicKey.export({ format: "jwk" }) as {
    kty?: string;
    n?: string;
    e?: string;
  };

  if (jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) {
    throw new EctlError(
      ECTL_ERROR_CODES.CONFIG_INVALID,
      "Only RSA private keys are supported for import.",
    );
  }

  const modulus = base64UrlToBuffer(jwk.n);
  const exponent = base64UrlToBuffer(jwk.e);

  const keyBlob = Buffer.concat([
    encodeSshString("ssh-rsa"),
    encodeSshMpint(exponent),
    encodeSshMpint(modulus),
  ]);

  return `ssh-rsa ${keyBlob.toString("base64")}`;
}
