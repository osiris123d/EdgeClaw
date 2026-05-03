import { getBrowserArtifactDisplayItems } from "../../lib/browserArtifacts";
import type { ActivityStep } from "../../types";

interface BrowserArtifactInlineSectionProps {
  steps: ActivityStep[];
}

export function BrowserArtifactInlineSection({ steps }: BrowserArtifactInlineSectionProps) {
  const items = getBrowserArtifactDisplayItems(steps);

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="browser-artifact-section" aria-label="Browser artifacts">
      {items.map((item) => (
        <article key={item.stepId} className={`browser-artifact-card status-${item.status}`}>
          {item.status === "image" ? (
            <>
              {/* Render screenshot inline if data URL available */}
              {(item.screenshotDataUrl || item.previewUrl) && (
                <div className="browser-artifact-preview-wrap">
                  <img
                    src={item.screenshotDataUrl || item.previewUrl}
                    alt={item.caption ?? "Browser screenshot preview"}
                    className="browser-artifact-preview"
                  />
                </div>
              )}
              <div className="browser-artifact-meta">
                <strong>Screenshot preview</strong>
                {item.pageUrl && <p>Source URL: {item.pageUrl}</p>}
                {item.caption && <p>{item.caption}</p>}
                {!item.screenshotDataUrl && !item.previewUrl && item.binaryRef && (
                  <p>Binary reference: {item.binaryRef}</p>
                )}
                {(item.width || item.height || item.mimeType) && (
                  <p>
                    {[item.mimeType, item.width && item.height ? `${item.width}x${item.height}` : undefined]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="browser-artifact-meta warning">
              <strong>Browser run completed, but no screenshot artifact was returned.</strong>
              {item.pageUrl && <p>Source URL: {item.pageUrl}</p>}
              {item.caption && <p>{item.caption}</p>}
            </div>
          )}

          {(item.rawMetadata || item.rawOutputText) && (
            <details className="browser-artifact-debug">
              <summary>Raw tool metadata</summary>
              <pre>
                {JSON.stringify(
                  {
                    rawOutputText: item.rawOutputText,
                    metadata: item.rawMetadata,
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
