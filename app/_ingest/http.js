const CODE_STATUS = Object.freeze({
  "file-too-large": 413,
  "invalid-source": 400,
  "storage-failed": 500,
});

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleIngestPost(request, deps) {
  const filename = request.headers.get("x-kiln-filename");
  const relationship = request.headers.get("x-kiln-relationship");
  const claimedLength = Number(request.headers.get("content-length"));
  const limit = deps.uploadLimit();
  if (!filename || filename.length > 255) return json({ ok: false, error: { code: "invalid-source" } }, 400);
  if (!request.body) return json({ ok: false, error: { code: "invalid-source" } }, 400);
  if (Number.isFinite(claimedLength) && claimedLength > limit)
    return json({ ok: false, error: { code: "file-too-large" } }, 413);
  try {
    const result = await deps.enqueueSource({
      source: request.body,
      filename,
      relationship,
      origin: "upload",
      mediaType: request.headers.get("content-type"),
      maxBytes: limit,
    });
    return json({ ok: true, job: result.job }, 202);
  } catch (error) {
    const code = error?.code in CODE_STATUS ? error.code : "processing-failed";
    return json({ ok: false, error: { code } }, CODE_STATUS[code] ?? 500);
  }
}

export function handleIngestGet(request, deps) {
  const id = new URL(request.url).searchParams.get("job");
  if (!id) return json({ ok: true, jobs: deps.listJobs() });
  try {
    const job = deps.getJob(id);
    return job ? json({ ok: true, job }) : json({ ok: false, error: { code: "unknown-job" } }, 404);
  } catch {
    return json({ ok: false, error: { code: "invalid-job" } }, 400);
  }
}
