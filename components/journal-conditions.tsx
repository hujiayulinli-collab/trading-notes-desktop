'use client';
import { useState } from 'react';
import { Plus, Trash2, RotateCcw, ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { createId } from '@/lib/id';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  conditionGroups,
  MAX_CONDITION_GROUPS,
  type ConditionGroup,
} from '@/lib/journal';

export function ConditionSettings({
  groups,
  onSave,
  onClose,
}: {
  groups: ConditionGroup[];
  onSave: (groups: ConditionGroup[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => conditionGroups(groups));
  const [error, setError] = useState('');
  const moveGroup = (index: number, offset: number) =>
    setDraft((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  const changeOption = (i: number, j: number, value: string) =>
    setDraft((current) =>
      current.map((group, index) =>
        index === i
          ? {
              ...group,
              options: group.options.map((option, n) =>
                n === j ? value : option,
              ),
            }
          : group,
      ),
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="journal-dialog condition-settings-dialog">
        <DialogTitle>自定义入场条件</DialogTitle>
        <DialogDescription>
          模块和其中的条件都可以添加、改名或移除，也可以调整模块顺序。电脑端每行显示
          4 个模块，旧手记已记录的条件文字会保留。
        </DialogDescription>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const next = conditionGroups(
                draft.map((group) => ({
                  ...group,
                  title: group.title.trim(),
                  options: group.options.map((option) => option.trim()),
                })),
              );
              onSave(next);
              onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : '条件无效。');
            }
          }}
        >
          <div className="condition-settings-grid">
            {draft.map((group, i) => (
              <fieldset key={group.id}>
                <legend>
                  模块 {i + 1}
                  <small>{group.options.length} / 50</small>
                </legend>
                <label className="condition-module-name">
                  模块名称
                  <input
                    required
                    maxLength={50}
                    aria-label={`模块 ${i + 1} 名称`}
                    value={group.title}
                    placeholder="例如 OB、趋势、入场"
                    onChange={(event) =>
                      setDraft((current) =>
                        current.map((item, index) =>
                          index === i
                            ? { ...item, title: event.target.value }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <div className="condition-module-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === 0}
                    aria-label={`前移模块 ${i + 1}`}
                    onClick={() => moveGroup(i, -1)}
                  >
                    <ArrowLeft size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={i === draft.length - 1}
                    aria-label={`后移模块 ${i + 1}`}
                    onClick={() => moveGroup(i, 1)}
                  >
                    <ArrowRight size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`删除模块 ${i + 1} ${group.title}`}
                    onClick={() =>
                      setDraft((current) =>
                        current.filter((_, index) => index !== i),
                      )
                    }
                  >
                    <Trash2 size={14} />
                    删除模块
                  </Button>
                </div>
                {group.options.map((option, j) => (
                  <div className="condition-edit-row" key={j}>
                    <input
                      required
                      maxLength={50}
                      aria-label={`${group.title}选项 ${j + 1}`}
                      value={option}
                      onChange={(e) => changeOption(i, j, e.target.value)}
                      placeholder="输入条件名称"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`移除${group.title}选项 ${j + 1}`}
                      onClick={() =>
                        setDraft((current) =>
                          current.map((item, index) =>
                            index === i
                              ? {
                                  ...item,
                                  options: item.options.filter(
                                    (_, n) => n !== j,
                                  ),
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={group.options.length >= 50}
                  onClick={() =>
                    setDraft((current) =>
                      current.map((item, index) =>
                        index === i
                          ? { ...item, options: [...item.options, ''] }
                          : item,
                      ),
                    )
                  }
                >
                  <Plus />
                  添加条件
                </Button>
              </fieldset>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={draft.length >= MAX_CONDITION_GROUPS}
            onClick={() => {
              setDraft((current) => [
                ...current,
                { id: createId(), title: '', options: [] },
              ]);
              setError('');
            }}
          >
            <Plus />
            添加模块（{draft.length}/{MAX_CONDITION_GROUPS}）
          </Button>
          {error && (
            <p className="negative" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-buttons">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(conditionGroups());
                setError('');
              }}
            >
              <RotateCcw />
              恢复默认模块
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit">保存条件</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
