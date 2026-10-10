/* oxlint-disable next/no-img-element -- Private signed screenshot URLs are resolved by the active storage client. */
'use client';
import { useEffect, useState } from 'react';
import type { Shot } from '@/lib/journal';
import type { JournalClient } from '@/lib/journal-client';
export function JournalImage({
  shot,
  client,
  savedTick = 0,
}: {
  shot: Shot;
  client: JournalClient;
  savedTick?: number;
}) {
  const [src, setSrc] = useState(''),
    [error, setError] = useState('');
  const tick = client.cloud ? 0 : savedTick;
  useEffect(() => {
    let active = true;
    const update = () =>
      void client
        .imageSource(shot)
        .then((url) => {
          if (active) {
            setSrc(client.cloud ? url : `${url}?v=${tick}`);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('截图暂时无法读取，请重新载入后重试。');
        });
    update();
    const timer = client.cloud ? setInterval(update, 51 * 60000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, shot, tick]);
  if (error) return <output className="screenshot-error">{error}</output>;
  return src ? (
    <img
      src={src}
      alt={`${shot.stage}截图：${shot.name}`}
      onError={() => setError('截图暂时无法读取，请重新载入后重试。')}
    />
  ) : (
    <span className="screenshot-error">正在读取截图…</span>
  );
}
