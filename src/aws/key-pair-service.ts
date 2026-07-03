import {
  CreateKeyPairCommand,
  ImportKeyPairCommand,
  type EC2Client,
} from "@aws-sdk/client-ec2";
import { wrapAwsError } from "./map-aws-error.js";
import { derivePublicKeyMaterialFromPrivatePem } from "./key-utils.js";

export interface CreateKeyPairResult {
  readonly keyPairName: string;
  readonly privateKeyPem: string;
}

export class KeyPairService {
  constructor(private readonly client: EC2Client) {}

  async createKeyPair(keyPairName: string): Promise<CreateKeyPairResult> {
    try {
      const response = await this.client.send(
        new CreateKeyPairCommand({ KeyName: keyPairName }),
      );

      if (response.KeyMaterial === undefined) {
        throw new Error("CreateKeyPair did not return key material.");
      }

      return {
        keyPairName,
        privateKeyPem: response.KeyMaterial,
      };
    } catch (error) {
      throw wrapAwsError(error, `Failed to create key pair '${keyPairName}'`);
    }
  }

  async importKeyPair(
    keyPairName: string,
    publicKeyMaterial: string,
  ): Promise<void> {
    try {
      await this.client.send(
        new ImportKeyPairCommand({
          KeyName: keyPairName,
          PublicKeyMaterial: Buffer.from(publicKeyMaterial, "utf8"),
        }),
      );
    } catch (error) {
      throw wrapAwsError(error, `Failed to import key pair '${keyPairName}'`);
    }
  }

  async importKeyPairFromPrivatePem(
    keyPairName: string,
    privateKeyPem: string,
  ): Promise<void> {
    const publicKeyMaterial =
      derivePublicKeyMaterialFromPrivatePem(privateKeyPem);
    await this.importKeyPair(keyPairName, publicKeyMaterial);
  }
}
