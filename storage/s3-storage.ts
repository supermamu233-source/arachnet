import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "@/lib/env";
import type { ObjectStorage } from "@/storage/object-storage";

const PRESIGN_PUT_EXPIRES_SECONDS = 5 * 60;

function createClient(): S3Client {
  const env = getEnv();
  return new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * S3-compatible implementation of {@link ObjectStorage}. Works against MinIO
 * in local dev/test and Cloudflare R2 in production — both speak the S3 API,
 * and `S3_FORCE_PATH_STYLE` is honored so MinIO's path-style bucket
 * addressing works (R2 also accepts path-style, so this is safe either way).
 */
class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.client = createClient();
    this.bucket = getEnv().S3_BUCKET_PRIVATE;
  }

  async presignPut(
    key: string,
    contentType: string,
    maxBytes: number,
  ): Promise<{ url: string; key: string }> {
    // maxBytes is intentionally not passed to the signature: a plain S3
    // presigned PUT has no byte-size condition (that's only available on a
    // presigned POST policy). It's accepted here to satisfy the
    // ObjectStorage interface and to make the caller's intent explicit; real
    // enforcement happens server-side in finalizeEvidence after upload.
    void maxBytes;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: PRESIGN_PUT_EXPIRES_SECONDS,
    });
    return { url, key };
  }

  async headObject(key: string): Promise<{ contentLength: number; contentType: string } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType ?? "application/octet-stream",
      };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === "NotFound") {
        return null;
      }
      // MinIO/S3 sometimes surface a missing object as a generic 404 without
      // the typed NotFound error; treat any $metadata.httpStatusCode 404 the
      // same way.
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = result.Body;
    if (!body) {
      throw new Error(`Object body missing for key: ${key}`);
    }
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async putObjectBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export const objectStorage: ObjectStorage = new S3ObjectStorage();
