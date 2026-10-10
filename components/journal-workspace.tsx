'use client';
import { isDesktop } from '@/lib/desktop';
import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { Session, SupabaseClient, User } from '@supabase/supabase-js';
import { Cloud, BookOpen, LogIn, LoaderCircle, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { localClient, type JournalClient } from '@/lib/journal-client';
import {
  CLOUD_CONFIG_KEY,
  CloudJournalClient,
  createCloudClient,
  validateCloudConfig,
  type CloudConfig,
} from '@/lib/journal-cloud';

type WorkspaceComponent = ComponentType<{
  client: JournalClient;
  manageCloud: () => Promise<void>;
}>;
export function JournalWorkspace({
  component: Component,
}: {
  component: WorkspaceComponent;
}) {
  const [initialized, setInitialized] = useState(false);
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const saved = isDesktop()
          ? null
          : localStorage.getItem(CLOUD_CONFIG_KEY);
        if (saved) setConfig(validateCloudConfig(JSON.parse(saved)));
      } catch {
        /* Invalid preferences never replace a library. */
      }
      setInitialized(true);
    });
  }, []);
  if (!initialized)
    return (
      <div className="loading-state">
        <LoaderCircle className="animate-spin" />
        正在打开手记…
      </div>
    );
  const useLocal = () => {
    localStorage.removeItem(CLOUD_CONFIG_KEY);
    setConfig(null);
  };
  return (
    <>
      {config ? (
        <CloudWorkspace
          key={config.url + config.key}
          config={config}
          useLocal={useLocal}
          component={Component}
        />
      ) : (
        <Component
          client={localClient}
          manageCloud={async () => {
            if (isDesktop()) await window.journalDesktop?.settings();
            else setSetup(true);
          }}
        />
      )}
      <Dialog open={setup} onOpenChange={setSetup}>
        <DialogContent className="journal-dialog settings-dialog">
          <DialogTitle>连接云端资料库</DialogTitle>
          <DialogDescription>
            连接后，交易与自定义条件保存在账号下。原本的本地资料可导出后再导入云端。
          </DialogDescription>
          <CloudSetup
            onConnect={(value) => {
              localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(value));
              setConfig(value);
              setSetup(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
function CloudSetup({
  onConnect,
}: {
  onConnect: (config: CloudConfig) => void;
}) {
  const [url, setUrl] = useState(''),
    [key, setKey] = useState(''),
    [error, setError] = useState('');
  return (
    <form
      className="form-stack cloud-setup"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          onConnect(validateCloudConfig({ url, key }));
        } catch (e) {
          setError(e instanceof Error ? e.message : '连接配置无效。');
        }
      }}
    >
      <ol className="cloud-steps">
        <li>
          在{' '}
          <a
            href="https://supabase.com/dashboard"
            target="_blank"
            rel="noreferrer"
          >
            Supabase 免费创建项目 ↗
          </a>
          。
        </li>
        <li>下载下面的建库文件，将全文复制到项目的 SQL Editor，点击 Run。</li>
        <li>
          在 Authentication → Users 中创建你的登录账号，并勾选 Auto confirm
          user。
        </li>
        <li>
          从项目的 Connect 面板复制 Project URL 和 Publishable key，填入下方。
        </li>
      </ol>
      <a
        className="setup-download"
        href="/cloud-setup.sql"
        download="盘口手记-云数据库.sql"
      >
        <Download size={16} />
        下载建库文件
      </a>
      <label>
        项目地址 · Project URL
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://你的项目编号.supabase.co"
          autoComplete="off"
        />
      </label>
      <label>
        公开连接密钥 · Publishable key
        <input
          required
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sb_publishable_…"
          autoComplete="off"
        />
      </label>
      <p>这里只保存项目的公开连接信息。数据访问由登录账号和数据库权限控制。</p>
      {error && (
        <p className="negative" role="alert">
          {error}
        </p>
      )}
      <Button type="submit">
        <Cloud />
        继续登录云端
      </Button>
    </form>
  );
}
function CloudWorkspace({
  config,
  useLocal,
  component: Component,
}: {
  config: CloudConfig;
  useLocal: () => void;
  component: WorkspaceComponent;
}) {
  const [client] = useState(() => createCloudClient(config));
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState<{
    user: User;
    store: CloudJournalClient;
  } | null>(null);
  const [sessionError, setSessionError] = useState('');
  const signingOut = useRef(false);
  useEffect(() => {
    let alive = true;
    const receive = (value: Session | null) => {
      if (!alive) return;
      setSession(value);
      setReady(true);
      if (value && !signingOut.current)
        setActive(
          (previous) =>
            previous || {
              user: value.user,
              store: new CloudJournalClient(
                client,
                value.user.id,
                value.user.email || '云端账号',
              ),
            },
        );
    };
    const { data: subscription } = client.auth.onAuthStateChange(
      (_event, value) => {
        receive(value);
      },
    );
    void client.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      receive(data.session);
      if (error) setSessionError('无法恢复登录，请重新登录。');
    });
    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
      void client.auth.stopAutoRefresh();
    };
  }, [client]);
  const signOut = async () => {
    signingOut.current = true;
    try {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw error;
      setSession(null);
      setActive(null);
    } finally {
      signingOut.current = false;
    }
  };
  if (!ready)
    return (
      <div className="loading-state">
        <LoaderCircle className="animate-spin" />
        正在恢复云端登录…
      </div>
    );
  const locked = active && session?.user.id !== active.user.id;
  return (
    <>
      {active && (
        <div inert={!!locked}>
          <Component client={active.store} manageCloud={signOut} />
        </div>
      )}
      {(!active || locked) && (
        <div className={active ? 'cloud-lock-screen' : 'cloud-login-screen'}>
          <div className="cloud-login-card">
            <span className="brand-mark">
              <BookOpen size={26} />
            </span>
            <h1>{active ? '重新登录以继续' : '登录盘口手记'}</h1>
            <p>
              {active
                ? '当前页面的未保存内容仍在，请使用原账号登录后重试保存。'
                : '交易、截图和入场条件，随你的账号在设备间使用。'}
            </p>
            <CloudLogin
              client={client}
              expectedUser={active?.user}
              initialError={sessionError}
            />
            {!active && (
              <Button
                variant="ghost"
                onClick={() =>
                  void signOut()
                    .then(useLocal)
                    .catch((e) => setSessionError(e.message))
                }
              >
                返回本地资料库 / 修改连接
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
function CloudLogin({
  client,
  expectedUser,
  initialError,
}: {
  client: SupabaseClient;
  expectedUser?: User;
  initialError: string;
}) {
  const [email, setEmail] = useState(expectedUser?.email || ''),
    [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(initialError),
    [failed, setFailed] = useState(!!initialError);
  const submit = async () => {
    setBusy(true);
    setMessage('');
    try {
      {
        const { data, error } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) throw error;
        if (expectedUser && data.user.id !== expectedUser.id) {
          await client.auth.signOut({ scope: 'local' });
          throw new Error('请登录原账号，保存当前内容后再切换账号。');
        }
      }
      setPassword('');
    } catch (e) {
      const text = e instanceof Error ? e.message : '连接失败';
      setFailed(true);
      setMessage(
        text.includes('Invalid login credentials')
          ? '邮箱或密码不正确，请检查后重试。'
          : text.includes('Email not confirmed')
            ? '账号尚未确认，请在 Supabase 后台确认该用户后登录。'
            : `登录未完成：${text}`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="form-stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        邮箱
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          readOnly={!!expectedUser}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="你的邮箱"
        />
      </label>
      <label>
        密码
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="输入手记账号密码"
        />
      </label>
      {message && (
        <output className={failed ? 'negative' : 'positive'}>{message}</output>
      )}
      <Button disabled={busy} type="submit">
        {busy ? <LoaderCircle className="animate-spin" /> : <LogIn />}
        {busy ? '正在连接…' : '登录'}
      </Button>
      {!expectedUser && (
        <p>
          首次使用，请先在 Supabase 的 Authentication → Users
          创建本人账号并勾选自动确认。这里使用手记账号密码。
        </p>
      )}
    </form>
  );
}
