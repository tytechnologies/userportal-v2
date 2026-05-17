import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export function getS3Client() {
  const config = useRuntimeConfig()
  const AWS_ACCESS_KEY_ID = config.AWS_ACCESS_KEY_ID
  const AWS_SECRET_ACCESS_KEY = config.AWS_SECRET_ACCESS_KEY
  const AWS_REGION = config.public.AWS_REGION || ''
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_REGION) {
    throw new Error('AWS credentials not configured')
  }
  return new S3Client({
    region: AWS_REGION,
    credentials: {
      accessKeyId: String(AWS_ACCESS_KEY_ID).trim(),
      secretAccessKey: String(AWS_SECRET_ACCESS_KEY).trim(),
    },
  })
}

// 1 hour default — matches getSignedDownloadUrl in s3.ts. Document
// download endpoints pass an explicit longer TTL when they need it.
export async function getSignedUrlForS3Key(s3Key: string, expiresIn = 3_600): Promise<string> {
  const config = useRuntimeConfig()
  const S3_BUCKET_NAME = config.public.S3_BUCKET_NAME as string
  if (!S3_BUCKET_NAME) throw new Error('S3_BUCKET_NAME not configured')
  const s3 = getS3Client()
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
  })
  return getSignedUrl(s3, command, { expiresIn })
}
