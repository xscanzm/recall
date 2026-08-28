interface Env {
  STATS_READ_TOKEN?: string;
  STATS_ADMIN_USERNAME?: string;
  STATS_ADMIN_PASSWORD?: string;
  INFOGRAPHIC_API_KEY?: string;
  DEFAULT_LANGUAGE_API_KEY?: string;
  DEFAULT_MULTIMODAL_API_KEY?: string;
  MODEL_STATS_HASH_SECRET?: string;
  MODEL_STATS: D1Database;
  MODEL_JOB_PAYLOADS: R2Bucket;
  TMP_IMAGES: R2Bucket;
  DEFAULT_MULTIMODAL_JOBS: Queue<DefaultMultimodalQueueMessage>;
}

interface DefaultMultimodalQueueMessage {
  version: 1;
  jobId: string;
}
