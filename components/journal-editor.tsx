/* oxlint-disable next/no-img-element -- Display local original screenshots without a remote image optimizer. */
'use client';
import { useRef, useState } from 'react';
import {
  Upload,
  Settings2,
  ShieldCheck,
  Trash2,
  ImagePlus,
  X,
  Expand,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Choice,
  NumberField,
  CategoryChoice,
} from '@/components/journal-controls';
import { ConditionSettings } from '@/components/journal-conditions';
import { JournalImage } from '@/components/journal-image';
import type { JournalClient } from '@/lib/journal-client';
import {
  type ConditionGroup,
  outcome,
  formatR,
  selectEntryConditions,
  type Trade,
  type Shot,
} from '@/lib/journal';

export function Editor({
  trade,
  onChange,
  onDelete,
  onUpload,
  onRemoveShot,
  demo,
  uploading,
  savedTick,
  groups,
  onGroupsChange,
  client,
}: {
  trade: Trade;
  onChange: (patch: Partial<Trade>) => void;
  onDelete: () => void;
  onUpload: (files: File[]) => void;
  onRemoveShot: (id: string) => void;
  demo: boolean;
  uploading: boolean;
  savedTick: number;
  groups: ConditionGroup[];
  onGroupsChange: (groups: ConditionGroup[]) => void;
  client: JournalClient;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false),
    [enlarged, setEnlarged] = useState<Shot | null>(null),
    [manageConditions, setManageConditions] = useState(false);
  const state = outcome(trade),
    positive =
      trade.status === 'closed' && trade.resultR !== null && trade.resultR > 0,
    negative =
      trade.status === 'closed' && trade.resultR !== null && trade.resultR < 0;
  const toggleTag = (tag: string) =>
    onChange(
      selectEntryConditions(
        trade,
        trade.tags.includes(tag)
          ? trade.tags.filter((x) => x !== tag)
          : [...trade.tags, tag].slice(0, 30),
        groups,
      ),
    );
  const otherConditions = [...new Set(trade.tags)].filter(
    (tag) => !groups.some((group) => group.options.includes(tag)),
  );
  const conditionOption = (tag: string) => (
    <label className={trade.tags.includes(tag) ? 'chosen' : ''} key={tag}>
      <Checkbox
        checked={trade.tags.includes(tag)}
        onCheckedChange={() => toggleTag(tag)}
        aria-label={tag}
      />
      <span>{tag}</span>
    </label>
  );
  return (
    <main className="editor-area">
      <div className="record-breadcrumb">
        交易手记<span>/</span>
        {trade.date.slice(0, 7).replace('-', ' 年 ')} 月<span>/</span>
        <b>{trade.symbol || '未命名'}</b>
        {demo ? (
          <span className="demo-badge">示例 · 不写入资料库</span>
        ) : (
          <span className="record-local">
            <ShieldCheck size={12} />
            {client.cloud ? '云端记录' : '本地记录'}
          </span>
        )}
      </div>
      <div className="record-heading">
        <div className="instrument-icon">
          {trade.symbol.includes('XAU')
            ? 'Au'
            : trade.symbol.slice(0, 2) || '—'}
        </div>
        <div className="record-titles">
          <input
            className="symbol-input"
            aria-label="交易品种"
            maxLength={32}
            value={trade.symbol}
            onChange={(e) => onChange({ symbol: e.target.value.toUpperCase() })}
            placeholder="交易品种"
          />
          <input
            className="title-input"
            aria-label="一句话手记"
            maxLength={160}
            value={trade.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="给这笔交易留一句话…"
          />
        </div>
        <div
          className={`record-result ${positive ? 'positive' : negative ? 'negative' : ''}`}
        >
          {trade.status === 'closed' && trade.resultR !== null
            ? `${formatR(trade.resultR)} R`
            : state}
          <span>{state === '待补 R' ? '填写结果后计入统计' : state}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="删除本笔交易"
          title="删除本笔交易"
          onClick={onDelete}
        >
          <Trash2 size={15} />
        </Button>
      </div>
      <div className="editor-fields">
        <label>
          交易日期
          <input
            type="date"
            required
            value={trade.date}
            onChange={(e) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value))
                onChange({ date: e.target.value });
            }}
          />
        </label>
        <label>
          入场时间
          <input
            type="time"
            value={trade.time}
            onChange={(e) => {
              if (e.target.value) onChange({ time: e.target.value });
            }}
          />
        </label>
        <label htmlFor="trade-timeframe">
          交易周期
          <Choice
            id="trade-timeframe"
            label="交易周期"
            value={trade.timeframe}
            options={['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D']}
            onChange={(timeframe) => onChange({ timeframe })}
          />
        </label>
        <NumberField
          label="风险 %"
          value={trade.riskPercent}
          onChange={(riskPercent) => onChange({ riskPercent })}
          min={0}
          max={100}
          placeholder="如 0.5"
        />
        <NumberField
          label="结果 R"
          value={trade.resultR}
          onChange={(resultR) => onChange({ resultR })}
          disabled={trade.status !== 'closed'}
          placeholder={trade.status === 'closed' ? '净结果 R' : '未平仓'}
        />
      </div>
      <div className="execution-row">
        <label className="category-field" htmlFor="trade-category">
          类别
          <CategoryChoice
            id="trade-category"
            value={trade.category}
            onChange={(category) => onChange({ category })}
          />
        </label>
        <Choice
          className={
            trade.direction === 'short' ? 'short-choice' : 'long-choice'
          }
          label="交易方向"
          value={trade.direction}
          options={[
            { value: 'long', label: '↗ 做多' },
            { value: 'short', label: '↘ 做空' },
          ]}
          onChange={(direction) =>
            onChange({ direction: direction as Trade['direction'] })
          }
        />
        <Choice
          label="交易状态"
          value={trade.status}
          options={[
            { value: 'open', label: '持仓中' },
            { value: 'closed', label: '已平仓' },
            { value: 'observing', label: '只观察' },
          ]}
          onChange={(status) =>
            onChange({
              status: status as Trade['status'],
              resultR: status === 'closed' ? trade.resultR : null,
            })
          }
        />
        <Choice
          label="纪律评价"
          value={trade.discipline}
          options={[
            { value: 'unrated', label: '纪律待评价' },
            { value: 'yes', label: '✓ 遵守计划' },
            { value: 'no', label: '违反计划' },
          ]}
          onChange={(discipline) =>
            onChange({ discipline: discipline as Trade['discipline'] })
          }
        />
        <Choice
          label="交易时段"
          value={trade.session}
          options={[
            '未标记',
            '亚洲时段',
            '伦敦时段',
            '纽约时段',
            '伦敦 / 纽约重叠',
          ]}
          onChange={(session) => onChange({ session })}
        />
      </div>
      <details className="price-details">
        <summary>
          价格与入场次数 <ChevronDown size={13} />
        </summary>
        <div className="editor-fields price-fields">
          <NumberField
            label="入场价"
            value={trade.entryPrice}
            onChange={(entryPrice) => onChange({ entryPrice })}
          />
          <NumberField
            label="初始止损价"
            value={trade.stopPrice}
            onChange={(stopPrice) => onChange({ stopPrice })}
          />
          <NumberField
            label="离场价"
            value={trade.exitPrice}
            onChange={(exitPrice) => onChange({ exitPrice })}
          />
          <NumberField
            label="第几次入场"
            value={trade.entryAttempt}
            onChange={(entryAttempt) => onChange({ entryAttempt })}
            min={1}
            max={100}
            step="1"
          />
        </div>
        <p>
          结果 R = 已实现净盈亏 ÷
          初始计划风险金额。请填包含费用的结果；价格仅供记录，不用于推算分批交易的收益。
        </p>
      </details>
      <section className="record-section">
        <div className="section-heading">
          <h3>
            <span>01</span>入场条件
          </h3>
          <div className="condition-actions">
            <span className="condition-state-key">● 已选　○ 未选</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setManageConditions(true)}
            >
              <Settings2 size={14} />
              自定义
            </Button>
          </div>
        </div>
        <div className="condition-groups">
          {groups.map((group) => (
            <fieldset className="condition-group" key={group.id ?? group.title}>
              <legend>{group.title}</legend>
              <div className="condition-tags">
                {group.options.map(conditionOption)}
                {!group.options.length && (
                  <span className="condition-empty">暂无选项</span>
                )}
              </div>
            </fieldset>
          ))}
        </div>
        {!groups.length && (
          <p className="condition-empty">
            暂无入场条件模块，点击“自定义”添加。
          </p>
        )}
        {otherConditions.length > 0 && (
          <div className="other-conditions">
            <span>其他已记录条件</span>
            <div className="condition-tags">
              {otherConditions.map(conditionOption)}
            </div>
          </div>
        )}
        {manageConditions && (
          <ConditionSettings
            groups={groups}
            onSave={onGroupsChange}
            onClose={() => setManageConditions(false)}
          />
        )}
      </section>
      <section className="record-section">
        <div className="section-heading">
          <h3>
            <span>02</span>图表截图 <small>{trade.screenshots.length}/8</small>
          </h3>
          <span>入场、持仓、离场</span>
        </div>
        <input
          className="sr-only"
          tabIndex={-1}
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          onChange={(e) => {
            onUpload(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
        {!!trade.screenshots.length && (
          <div className="screenshots-grid">
            {trade.screenshots.map((shot) => (
              <figure className="screenshot-card" key={shot.id}>
                <button
                  className="screenshot-preview"
                  onClick={() => setEnlarged(shot)}
                  aria-label={`放大截图 ${shot.name}`}
                >
                  <JournalImage
                    shot={shot}
                    client={client}
                    savedTick={savedTick}
                  />
                  <span>
                    <Expand size={16} />
                  </span>
                </button>
                <figcaption>
                  <Choice
                    label={`${shot.name}截图阶段`}
                    value={shot.stage}
                    options={['入场', '持仓', '离场']}
                    onChange={(stage) =>
                      onChange({
                        screenshots: trade.screenshots.map((s) =>
                          s.id === shot.id ? { ...s, stage } : s,
                        ),
                      })
                    }
                  />
                  <span title={shot.name}>{shot.name}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`移除截图 ${shot.name}`}
                    onClick={() => onRemoveShot(shot.id)}
                  >
                    <X />
                  </Button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        {trade.screenshots.length < 8 && (
          <button
            disabled={uploading || demo}
            className={`upload-zone ${dragging ? 'dragging' : ''} ${trade.screenshots.length ? 'compact-upload' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!demo && !uploading)
                onUpload(Array.from(e.dataTransfer.files));
            }}
          >
            <span className="upload-symbol">
              {trade.screenshots.length ? (
                <ImagePlus size={22} />
              ) : (
                <Upload size={22} />
              )}
            </span>
            <strong>
              {uploading
                ? '正在保存截图…'
                : trade.screenshots.length
                  ? '继续添加截图'
                  : '把交易图表留在这里'}
            </strong>
            <span>
              {demo
                ? '新建你的第一笔交易，即可上传图表'
                : '点击上传或拖入截图，也可以直接 Ctrl + V 粘贴'}
            </span>
            <small>
              PNG、JPG、WEBP · 单张 ≤ 8 MB · 原图保存在
              {client.cloud ? '私有云端' : '本地'}
            </small>
          </button>
        )}
      </section>
      <section className="record-section">
        <div className="section-heading">
          <h3>
            <span>03</span>交易复盘
          </h3>
          <span>比盈亏更重要的是决策过程</span>
        </div>
        <div className="entry-score-row">
          <NumberField
            label="入场打分（0–100 分）"
            value={trade.entryScore ?? null}
            onChange={(entryScore) => onChange({ entryScore })}
            min={0}
            max={100}
            placeholder="未评分"
          />
          <span>按入场时的条件和执行质量评分，可留空。</span>
        </div>
        <div className="review-grid">
          {(
            [
              {
                key: 'entry',
                title: '进场依据',
                sub: '条件自动填入，可继续补充',
                placeholder: '方向、关键位置、入场信号…',
              },
              {
                key: 'execution',
                title: '执行过程',
                sub: '计划与实际，有什么不同',
                placeholder: '实际怎么做的，止损、减仓与离场…',
              },
              {
                key: 'lessons',
                title: '做对与做错',
                sub: '只记录真正发生的事',
                placeholder: '哪些决策值得重复，哪些需要修正？',
              },
              {
                key: 'improvement',
                title: '下次改进',
                sub: '一条具体、可以执行的改变',
                placeholder: '下一次遇到类似机会，我会…',
              },
            ] as const
          ).map((x) => (
            <label className="review-card" key={x.key} aria-label={x.title}>
              <span>
                <b>{x.title}</b>
                <small>{x.sub}</small>
              </span>
              <textarea
                maxLength={12000}
                value={trade.notes[x.key]}
                onChange={(e) =>
                  onChange({
                    notes: { ...trade.notes, [x.key]: e.target.value },
                    ...(x.key === 'entry' ? { entryAutoText: null } : {}),
                  })
                }
                placeholder={x.placeholder}
              />
            </label>
          ))}
        </div>
      </section>
      <Dialog
        open={!!enlarged}
        onOpenChange={(open) => {
          if (!open) setEnlarged(null);
        }}
      >
        <DialogContent className="image-dialog">
          <DialogTitle>{enlarged?.name}</DialogTitle>
          <DialogDescription>
            {enlarged?.stage}截图 · 原图预览
          </DialogDescription>
          {enlarged && (
            <JournalImage
              shot={enlarged}
              client={client}
              savedTick={savedTick}
            />
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
