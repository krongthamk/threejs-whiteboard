import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, LogOut, Plus, SquarePen, X } from 'lucide-react';
import { api, ApiError, type BoardInfo, type Session } from './api';
import { Modal } from './modal';

export interface BoardAccess { session: Session; board: BoardInfo; onBack(): void; onSignOut(): void; onBoardChange(board: BoardInfo): void }
const routeBoard = () => /^\/board\/([^/]+)\/?$/.exec(location.pathname)?.[1];

export function AccountAccess({ children }: { children(access: BoardAccess): ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [board, setBoard] = useState<BoardInfo | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [creating, setCreating] = useState(false), [busy, setBusy] = useState(false);
  const navigation = useRef(0);

  const enter = (selected: BoardInfo) => { navigation.current++; history.pushState({}, '', `/board/${encodeURIComponent(selected.id)}`); setBoard(selected); setError(''); };
  const loadBoards = async (ticket = navigation.current) => { const result = await api.boards(); if (ticket === navigation.current) setBoards(result); return result; };
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await api.session(); if (cancelled) return;
        setSession(restored);
        const list = await api.boards(); if (cancelled) return;
        setBoards(list);
        const id = routeBoard();
        if (id) { const ticket = navigation.current, found = await api.board(decodeURIComponent(id)); if (!cancelled && ticket === navigation.current && routeBoard() === id) setBoard(found); }
      } catch (cause) {
        if (!cancelled && !(cause instanceof ApiError && cause.status === 401)) setError(cause instanceof Error ? cause.message : 'The workspace could not open. Please try again.');
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const navigate = () => {
      const id = routeBoard(), ticket = ++navigation.current;
      setBoard(null); setCreating(false); setError('');
      if (!id) { if (session) void loadBoards(ticket).catch(cause => { if (ticket === navigation.current) setError(String(cause.message)); }); }
      else if (session) void api.board(decodeURIComponent(id)).then(value => { if (ticket === navigation.current && routeBoard() === id) setBoard(value); }).catch(cause => { if (ticket === navigation.current) setError(String(cause.message)); });
    };
    window.addEventListener('popstate', navigate); return () => window.removeEventListener('popstate', navigate);
  }, [session]);

  const login = async (username: string, password: string) => {
    const ticket = ++navigation.current;
    setBusy(true); setError('');
    try {
      const next = await api.login(username, password); if (ticket !== navigation.current) return; setSession(next);
      const list = await loadBoards(ticket); if (ticket !== navigation.current) return;
      const id = routeBoard();
      if (id) { const found = await api.board(decodeURIComponent(id)); if (ticket === navigation.current && routeBoard() === id) setBoard(found); }
      else if (list.length === 1) enter(list[0]!);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed. Please try again.'); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    navigation.current++;
    try { await api.logout(); }
    catch (cause) {
      // An expired/revoked session is already signed out on the server. Clear
      // the stale UI so the user can authenticate again without a page reload.
      if (!(cause instanceof ApiError && cause.status === 401)) { setError(cause instanceof Error ? cause.message : 'Could not sign out. Please try again.'); return; }
    }
    navigation.current++; setBoard(null); setBoards([]); setSession(null); setError(''); history.pushState({}, '', '/');
  };
  const back = () => { navigation.current++; setBoard(null); history.pushState({}, '', '/'); void loadBoards().catch(cause => setError(String(cause.message))); };
  const create = async (title: string) => {
    const ticket = ++navigation.current;
    setBusy(true); setError('');
    try { const created = await api.createBoard(title.trim() || 'Untitled board'); if (ticket === navigation.current) { setCreating(false); enter(created); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The board could not be created.'); }
    finally { setBusy(false); }
  };
  const banner = error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>;

  if (loading) return <div className="account-page"><div className="account-loading" role="status">Opening your workspace…</div></div>;
  if (session && board) return <>{children({ session, board, onBack: back, onSignOut: () => void signOut(), onBoardChange: value => { if (decodeURIComponent(routeBoard() ?? '') === value.id) setBoard(value); } })}{banner}</>;
  if (!session) return <div className="account-page"><div className="account-brand"><SquarePen size={23} /><span>Whiteboard</span></div><SignIn onSubmit={login} busy={busy} />{banner}</div>;
  return <div className="account-page boards-page">
    <header className="account-topbar"><div className="account-brand"><SquarePen size={23} /><span>Whiteboard</span></div><div className="account-user"><span>{session.user.name ?? session.user.username}</span><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}><LogOut size={18} /></button></div></header>
    <section className="boards-content"><div className="boards-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Room for the next idea.</h1><p>Pick up where you left off, or start a fresh board.</p></div><button className="primary-button" onClick={() => setCreating(true)}><Plus size={17} />New board</button></div>
      <div className="board-list" aria-label="Your boards">
        {boards.map((item, index) => <button className="board-card surface" key={item.id} onClick={() => enter(item)}><div className={`board-card-preview palette-${index % 3}`} aria-hidden="true"><span /><i /><b /></div><div className="board-card-details"><h2>{item.title}</h2><div><span>{item.role === 'viewer' ? 'View only' : item.role === 'owner' ? 'Your board' : 'Shared with you'}</span><span>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></div></div></button>)}
        {!boards.length && <button className="empty-board-card" onClick={() => setCreating(true)}><span><Plus size={24} /></span><h2>Your first board starts here</h2><p>A space for notes, sketches and shared thinking.</p></button>}
      </div>
    </section>
    {creating && <Modal title="A fresh board" onClose={() => !busy && setCreating(false)}><NewBoard busy={busy} onSubmit={create} /></Modal>}
    {banner}
  </div>;
}

function SignIn({ onSubmit, busy }: { onSubmit(username: string, password: string): Promise<void>; busy: boolean }) {
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (username.trim() && password) void onSubmit(username.trim(), password); };
  return <section className="signin-card surface"><p className="eyebrow">WELCOME BACK</p><h1>Make space<br />for your ideas.</h1><p>Sign in with your workspace account.</p><form onSubmit={submit}>
    <label htmlFor="username">Username</label><input autoFocus id="username" name="username" autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)} />
    <label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} />
    <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<ArrowRight size={17} /></button>
  </form></section>;
}

function NewBoard({ onSubmit, busy }: { onSubmit(title: string): Promise<void>; busy: boolean }) {
  const [title, setTitle] = useState('');
  return <form className="simple-form" onSubmit={event => { event.preventDefault(); void onSubmit(title); }}><label htmlFor="board-title">Board name</label><input autoFocus id="board-title" maxLength={120} value={title} placeholder="Untitled board" onChange={event => setTitle(event.target.value)} /><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create board'}<ArrowRight size={17} /></button></form>;
}
