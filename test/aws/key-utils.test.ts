import { describe, expect, it } from "vitest";
import { derivePublicKeyMaterialFromPrivatePem } from "../../src/aws/key-utils.js";

const SAMPLE_RSA_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8yCoM0V2V3q3F3V3q3F3V3q3F3
V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3
q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3
F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F
3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3
V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V
3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3
q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q
3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3
F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3F3V3q3
QIDAQABAoIBADfake
-----END RSA PRIVATE KEY-----`;

describe("derivePublicKeyMaterialFromPrivatePem", () => {
  it("rejects invalid PEM content", () => {
    expect(() => derivePublicKeyMaterialFromPrivatePem("not-a-key")).toThrow(
      /Invalid private key PEM/,
    );
  });

  it("rejects non-RSA keys", () => {
    const ecPrivateKey = `-----BEGIN PRIVATE KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0CAQEEAwJQQQtFakeBase64PayloadForTestOnly==
-----END PRIVATE KEY-----`;

    expect(() => derivePublicKeyMaterialFromPrivatePem(ecPrivateKey)).toThrow();
  });
});
