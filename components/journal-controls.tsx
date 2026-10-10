'use client';
import { isDesktop } from '@/lib/desktop';
import { useState } from 'react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  ArrowRight,
  FolderOpen,
  KeyRound,
  Download,
  Upload,
  ShieldCheck,
  Cloud,
  LogOut,
} from 'lucide-react';
import {
  TRADE_CATEGORIES,
  baseRiskPercent,
  type Trade,
  type TradeCategory,
} from '@/lib/journal';

export function BaseRiskControl({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState('');
  return (
    <form
      className="base-risk-control"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const next = baseRiskPercent(draft.trim() ? Number(draft) : null);
          onChange(next);
          setDraft(String(next));
          setError('');
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <label htmlFor="base-risk-percent">
        基础 1R =
        <input
          id="base-risk-percent"
          type="number"
          min="0.0001"
          max="100"
          step="any"
          value={draft}
          disabled={disabled}
          aria-describedby="base-risk-hint"
          aria-invalid={!!error}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
          }}
        />
        %
      </label>
      <Button
        size="sm"
        variant="outline"
        type="submit"
        disabled={disabled || draft === String(value)}
      >
        应用
      </Button>
      <span id="base-risk-hint" role={error ? 'alert' : undefined}>
        {error || '按此基准换算收益，应用后自动保存'}
      </span>
    </form>
  );
}

export function CategoryChoice({
  value,
  onChange,
  id,
}: {
  value: TradeCategory | undefined;
  onChange: (category: TradeCategory) => void;
  id: string;
}) {
  return (
    <Choice
      id={id}
      label="记录类别"
      value={value ?? 'unclassified'}
      options={[
        ...(!value ? [{ value: 'unclassified', label: '未分类' }] : []),
        { value: 'live', label: TRADE_CATEGORIES.live },
        { value: 'review', label: TRADE_CATEGORIES.review },
      ]}
      onChange={(category) => {
        if (category === 'live' || category === 'review') onChange(category);
      }}
    />
  );
}

export function Choice({
  value,
  options,
  onChange,
  label,
  className = '',
  id,
}: {
  value: string;
  options: string[] | { value: string; label: string }[];
  onChange: (v: string) => void;
  label: string;
  className?: string;
  id?: string;
}) {
  const items = options.map((x) =>
    typeof x === 'string' ? { value: x, label: x } : x,
  );
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
      items={items}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        className={`choice ${className}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map((x) => (
          <SelectItem key={x.value} value={x.value}>
            {x.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 'any',
  placeholder = '未填写',
  disabled = false,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  min?: number;
  max?: number;
  step?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [error, setError] = useState('');
  const [previousValue, setPreviousValue] = useState(value);
  if (value !== previousValue) {
    setPreviousValue(value);
    setText(value === null ? '' : String(value));
    setError(
      value !== null &&
        ((min !== undefined && value < min) ||
          (max !== undefined && value > max) ||
          (step === '1' && !Number.isInteger(value)))
        ? '数值超出范围，无法保存'
        : '',
    );
  }
  const edit = (next: string) => {
    setText(next);
    if (next.trim() === '') {
      if (value !== null) onChange(null);
      setError('');
      return;
    }
    const n = Number(next);
    if (!Number.isFinite(n)) {
      setError('请输入有效数字');
      return;
    }
    const invalid =
      (min !== undefined && n < min) ||
      (max !== undefined && n > max) ||
      (step === '1' && !Number.isInteger(n));
    setError(invalid ? '数值超出范围，无法保存' : '');
    if (n !== value) onChange(n);
  };
  return (
    <label>
      {label}
      <input
        type="number"
        value={text}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={!!error}
      />
      {error && <small className="negative">{error}</small>}
    </label>
  );
}
export function CreateDialog({
  draft,
  setDraft,
  onCreate,
  busy,
}: {
  draft: Trade | null;
  setDraft: (t: Trade | null) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  return (
    <Dialog
      open={!!draft}
      onOpenChange={(v) => {
        if (!v && !busy) setDraft(null);
      }}
    >
      <DialogContent className="journal-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>记录一笔交易</DialogTitle>
          <DialogDescription>
            先记下品种和时间，进场依据与图表可以随后补充。
          </DialogDescription>
        </DialogHeader>
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onCreate();
            }}
          >
            <div className="form-stack">
              <label htmlFor="create-category">
                记录类别
                <CategoryChoice
                  id="create-category"
                  value={draft.category}
                  onChange={(category) => setDraft({ ...draft, category })}
                />
                <small className="category-hint">
                  按新建时的 UTC+8
                  日期：周六、周日默认复盘，其余默认实盘；可手动修改。
                </small>
              </label>
              <label>
                交易品种
                <input
                  required
                  maxLength={32}
                  value={draft.symbol}
                  onChange={(e) =>
                    setDraft({ ...draft, symbol: e.target.value.toUpperCase() })
                  }
                  placeholder="如 XAUUSD、NQ、BTCUSDT"
                />
              </label>
              <label>
                一句话手记
                <input
                  maxLength={160}
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                  placeholder="给这次交易一个简短描述（选填）"
                />
              </label>
              <div className="form-two">
                <label>
                  交易日期
                  <input
                    type="date"
                    required
                    value={draft.date}
                    onChange={(e) =>
                      setDraft({ ...draft, date: e.target.value })
                    }
                  />
                </label>
                <label>
                  入场时间
                  <input
                    type="time"
                    required
                    value={draft.time}
                    onChange={(e) =>
                      setDraft({ ...draft, time: e.target.value })
                    }
                  />
                </label>
              </div>
              <div className="form-two">
                <label htmlFor="create-direction">
                  方向
                  <Choice
                    id="create-direction"
                    label="新交易方向"
                    value={draft.direction}
                    onChange={(direction) =>
                      setDraft({
                        ...draft,
                        direction: direction as Trade['direction'],
                      })
                    }
                    options={[
                      { value: 'long', label: '↗ 做多' },
                      { value: 'short', label: '↘ 做空' },
                    ]}
                  />
                </label>
                <label htmlFor="create-status">
                  交易状态
                  <Choice
                    id="create-status"
                    label="新交易状态"
                    value={draft.status}
                    onChange={(status) =>
                      setDraft({ ...draft, status: status as Trade['status'] })
                    }
                    options={[
                      { value: 'open', label: '持仓中' },
                      { value: 'closed', label: '已平仓' },
                      { value: 'observing', label: '只观察' },
                    ]}
                  />
                </label>
              </div>
            </div>
            <div className="dialog-buttons">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDraft(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy || !draft.symbol.trim()}>
                {busy ? '正在保存…' : '创建手记'}
                <ArrowRight />
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function SettingsDialog({
  open,
  onOpenChange,
  directory,
  apiKey,
  setApiKey,
  model,
  setModel,
  onMigrate,
  onExport,
  onImport,
  busy,
  cloud,
  onManageCloud,
  onDesktopLock,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  directory: string;
  apiKey: string;
  setApiKey: (s: string) => void;
  model: string;
  setModel: (s: string) => void;
  onMigrate: (s: string) => Promise<void>;
  onExport: () => void;
  onImport: () => void;
  busy: boolean;
  cloud: boolean;
  onManageCloud: () => void;
  onDesktopLock: () => void;
}) {
  const [target, setTarget] = useState('');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="journal-dialog settings-dialog">
        <DialogHeader>
          <DialogTitle>手记设置</DialogTitle>
          <DialogDescription>管理资料库与 GPT 复盘连接。</DialogDescription>
        </DialogHeader>
        <section className="settings-section">
          <h3>
            <FolderOpen size={17} />
            {cloud ? '云端资料库' : '数据保存位置'}
          </h3>
          {isDesktop() && (
            <p>
              桌面本地资料库：不连接云端账号。GPT
              复盘仅在你主动操作时发送所选资料。
            </p>
          )}
          <p className="directory-display">{directory || '正在连接资料库…'}</p>
          {!cloud && (
            <>
              <p>
                交易写入 journal.json，截图保存在 screenshots
                文件夹。修改后自动保存，原始截图不压缩。
              </p>
              <div className="form-stack">
                <label>
                  迁移到新的空文件夹
                  <input
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="例如 D:\我的交易\盘口手记"
                  />
                </label>
              </div>
              {isDesktop() && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void window.journalDesktop
                      ?.chooseDirectory()
                      .then((folder) => {
                        if (folder) setTarget(folder);
                      })
                      .catch(() => {})
                  }
                >
                  <FolderOpen />
                  选择文件夹
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || !target.trim()}
                onClick={() =>
                  void onMigrate(target)
                    .then(() => setTarget(''))
                    .catch(() => {})
                }
              >
                <FolderOpen />
                {busy ? '处理中…' : '迁移资料库'}
              </Button>
              <small>
                复制并校验成功后切换；原文件夹会保留。换电脑可导入完整备份，或复制整个数据文件夹。
              </small>
            </>
          )}
          {cloud && (
            <p>
              交易、截图、自定义条件及复盘保存在此账号下。编辑后自动保存；回到页面时检查其他设备的更新。导入备份会追加新记录，并跳过相同
              ID 的已有交易。
            </p>
          )}
          <div className="button-pair">
            <Button variant="outline" onClick={onExport} disabled={busy}>
              <Download />
              导出完整备份
            </Button>
            <Button variant="outline" onClick={onImport} disabled={busy}>
              <Upload />
              导入备份
            </Button>
          </div>
          {isDesktop() && (
            <div className="button-pair">
              <Button variant="outline" disabled={busy} onClick={onManageCloud}>
                本地应用锁设置
              </Button>
              <Button variant="outline" disabled={busy} onClick={onDesktopLock}>
                立即锁定
              </Button>
            </div>
          )}
          {!isDesktop() && (
            <Button variant="outline" disabled={busy} onClick={onManageCloud}>
              {cloud ? <LogOut /> : <Cloud />}
              {cloud ? '保存并退出登录' : '连接云端资料库'}
            </Button>
          )}
          {!cloud && !isDesktop() && (
            <small>
              登录云端后可在不同设备使用同一份资料。本地数据可先导出，再导入云端。
            </small>
          )}
        </section>
        <section className="settings-section">
          <h3>
            <KeyRound size={17} />
            GPT 连接
          </h3>
          <div className="form-stack">
            <label>
              OpenAI API Key
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…（仅保留在当前页面内存中）"
              />
            </label>
            <label>
              模型名称
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="gpt-5.4-mini"
              />
            </label>
          </div>
          <p>
            点击“请 GPT 复盘”才会把所选资料发送给 OpenAI。API
            单独计费；也可以不填密钥，复制资料到 ChatGPT 使用。
          </p>
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            在 OpenAI 创建 API Key ↗
          </a>
          <div className="privacy-note">
            <ShieldCheck size={16} />
            密钥不写入本地文件、不进入备份；刷新页面后需重新填写。
          </div>
        </section>
        <Button className="wide" onClick={() => onOpenChange(false)}>
          完成
        </Button>
      </DialogContent>
    </Dialog>
  );
}
