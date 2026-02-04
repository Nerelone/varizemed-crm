import { getSafeMediaUrl, MediaAttachment as MediaItem } from "../../shared/utils/mediaUrl";
import { Message } from "./chatApi";

function normalizeAttachments(message: Message): MediaItem[] {
  const attachments: MediaItem[] = [];

  if (Array.isArray(message.media)) attachments.push(...message.media);
  if (Array.isArray(message.media_urls)) attachments.push(...message.media_urls.map((url) => ({ url })));
  if (message.media_url) attachments.push({ url: message.media_url, content_type: message.media_type || message.mime });
  if (message.url && (message.mime || message.content_type)) {
    attachments.push({ url: message.url, content_type: message.mime || message.content_type });
  }

  return attachments;
}

export function MediaAttachment({ message, conversationId }: { message: Message; conversationId: string }) {
  const attachments = normalizeAttachments(message);
  if (!attachments.length) return null;

  return (
    <div className="attachments">
      {attachments.map((attachment, index) => {
        const url = getSafeMediaUrl(conversationId, message.message_id, attachment);
        if (!url) return null;

        const raw = (attachment.content_type || attachment.mime || "").toLowerCase();
        const contentType = raw.split(";")[0].trim();
        const isOgg = /\.ogg(\?.*)?$/i.test(url);
        const isAudio = contentType.startsWith("audio/") || contentType === "application/ogg";
        const isImage = contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(url);

        if (isAudio || isOgg || /\.(mp3|wav)(\?.*)?$/i.test(url)) {
          return (
            <audio
              key={`${url}-${index}`}
              controls
              preload="none"
              style={{ display: "block", marginTop: 6 }}
            >
              <source src={url} type={contentType === "application/ogg" || !contentType ? "audio/ogg" : contentType} />
              Seu navegador não conseguiu reproduzir este áudio.
            </audio>
          );
        }

        if (isImage) {
          return (
            <img
              key={`${url}-${index}`}
              src={url}
              alt="Anexo"
              style={{ maxWidth: 260, borderRadius: 8, display: "block", marginTop: 6 }}
            />
          );
        }

        return (
          <a
            key={`${url}-${index}`}
            href={url}
            target="_blank"
            rel="noopener"
            style={{ display: "inline-block", marginTop: 6 }}
          >
            Abrir anexo
          </a>
        );
      })}
    </div>
  );
}
