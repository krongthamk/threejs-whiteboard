import { useState } from 'react';
import type { User } from './api';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Public profiles supply only a local URL; a new revision gets a fresh load attempt. */
export function AccountAvatar({ user }: { user: User }) {
  return user.avatarUrl ? <AvatarImage key={user.avatarUrl} url={user.avatarUrl} name={user.name ?? user.username} /> : null;
}

function AvatarImage({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const label = `${name}'s profile picture`;
  if (failed) {
    const initial = graphemes.segment(name)[Symbol.iterator]().next().value?.segment ?? '?';
    return <span className="account-avatar account-avatar-fallback" role="img" aria-label={label} title={`${name} · profile picture unavailable`}>{initial}</span>;
  }
  return <img className="account-avatar" src={url} alt={label} width={28} height={28} onError={() => setFailed(true)} />;
}
