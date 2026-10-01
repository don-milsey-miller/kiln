"use client";

import { useEffect, useRef, useState } from "react";

const MESSAGE = {
  "source-not-activated": "Source ingestion is available after the source artifact type is activated for this project.",
  "processor-unavailable": "The source was retained, but its optional processor is not configured.",
  "unsupported-type": "This file type is not supported by an available processor.",
  "file-too-large": "The file is larger than this project's configured ingestion limit.",
  "invalid-source": "Kiln could not safely read this source.",
  "processing-failed": "Kiln retained the source, but normalization did not complete.",
};

function upload(file, relationship, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/ingest");
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    request.setRequestHeader("x-kiln-filename", file.name);
    request.setRequestHeader("x-kiln-relationship", relationship);
    request.upload.onprogress = (event) => onProgress(event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : null);
    request.onerror = () => reject(new Error("network"));
    request.onload = () => {
      try {
        const body = JSON.parse(request.responseText);
        if (request.status >= 200 && request.status < 300) resolve(body.job);
        else reject(Object.assign(new Error(body.error?.code ?? "processing-failed"), { code: body.error?.code }));
      } catch {
        reject(new Error("processing-failed"));
      }
    };
    request.send(file);
  });
}

export default function IngestPanel() {
  const [relationship, setRelationship] = useState("project-manager-input");
  const [jobs, setJobs] = useState([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  const refresh = async () => {
    const response = await fetch("/api/ingest", { cache: "no-store" });
    const body = await response.json();
    if (body.ok) setJobs(body.jobs);
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, []);

  const accept = async (files) => {
    for (const file of files) {
      const localId = `upload-${crypto.randomUUID()}`;
      setJobs((current) => [{ jobId: localId, filename: file.name, state: "uploading", progress: 0 }, ...current]);
      try {
        const job = await upload(file, relationship, (progress) =>
          setJobs((current) => current.map((item) => (item.jobId === localId ? { ...item, progress } : item)))
        );
        setJobs((current) => [job, ...current.filter((item) => item.jobId !== localId)]);
      } catch (error) {
        setJobs((current) =>
          current.map((item) => item.jobId === localId ? { ...item, state: "failed", error: { code: error.code ?? "processing-failed" } } : item)
        );
      }
    }
  };

  return (
    <section aria-labelledby="source-ingestion" style={{ border: "1px solid #d8d8d8", borderRadius: 8, padding: 18, marginBottom: 28 }}>
      <h2 id="source-ingestion" style={{ margin: "0 0 4px", fontSize: "1.05rem" }}>Add source material</h2>
      <p style={{ color: "#666", margin: "0 0 14px" }}>
        Drop a file here, or place one in <code>.pi/ingest/inbox</code>. Raw files remain local; normalized text becomes a typed source.
      </p>
      <label style={{ display: "block", marginBottom: 10 }}>
        Relationship{" "}
        <select value={relationship} onChange={(event) => setRelationship(event.target.value)}>
          <option value="project-manager-input">Project-manager input</option>
          <option value="external-reference">External reference</option>
        </select>
      </label>
      <div
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); void accept(event.dataTransfer.files); }}
        style={{ border: `2px dashed ${dragging ? "#2368d1" : "#aaa"}`, borderRadius: 8, padding: 22, textAlign: "center", background: dragging ? "#f2f7ff" : "#fafafa" }}
      >
        <input ref={input} type="file" multiple hidden onChange={(event) => void accept(event.target.files)} />
        <button type="button" onClick={() => input.current?.click()}>Choose files</button>
        <span style={{ marginLeft: 10, color: "#666" }}>or drag and drop</span>
      </div>
      {jobs.length > 0 && (
        <ul aria-label="Ingestion jobs" style={{ listStyle: "none", padding: 0, margin: "14px 0 0" }}>
          {jobs.slice(0, 8).map((job) => (
            <li key={job.jobId} style={{ borderTop: "1px solid #eee", padding: "9px 0" }}>
              <strong>{job.filename}</strong>{" "}
              <span>{job.state === "uploading" && job.progress != null ? `uploading ${job.progress}%` : job.state}</span>
              {job.sourceId && <span> · <code>{job.sourceId}</code></span>}
              {job.error?.code && <div role="status" style={{ color: "#9c2f1b" }}>{MESSAGE[job.error.code] ?? MESSAGE["processing-failed"]}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
