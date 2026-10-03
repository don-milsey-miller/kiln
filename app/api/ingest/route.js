import { enqueueSource, getIngestJob, ingestUploadLimit, listIngestJobs } from "../../server/ingest.js";
import { handleIngestGet, handleIngestPost } from "../../_ingest/http.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deps = {
  enqueueSource,
  getJob: getIngestJob,
  listJobs: listIngestJobs,
  uploadLimit: ingestUploadLimit,
};

export const POST = (request) => handleIngestPost(request, deps);
export const GET = async (request) => handleIngestGet(request, deps);
