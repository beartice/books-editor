import { useStore } from '../store';
import { cn } from '../utils';
import { IconClose } from './icons';

export default function Toasts() {
  const { toasts, dismissToast, answerToast } = useStore();

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex items-start gap-3 rounded-2xl border bg-white px-4 py-3 text-[12.5px] shadow-panel animate-fade-in',
            toast.tone === 'success' && 'border-accent-500/20 text-ink-200',
            toast.tone === 'error' && 'border-rose-500/25 text-rose-600',
            toast.tone === 'info' && 'border-black/[0.07] text-ink-200',
          )}
        >
          <span
            className={cn(
              'mt-1 h-2 w-2 shrink-0 rounded-full',
              toast.tone === 'success' && 'bg-accent-500',
              toast.tone === 'error' && 'bg-rose-500',
              toast.tone === 'info' && 'bg-coral-500',
            )}
          />
          <div className="flex-1">
            <span className="leading-relaxed">{toast.message}</span>
            {toast.actions && (
              <div className="mt-2 flex flex-wrap gap-2">
                {toast.actions.map((action) => (
                  <button
                    key={action.value}
                    onClick={() => answerToast(toast.id, action.value)}
                    className={cn(
                      action.primary ? 'btn-primary' : 'btn-ghost',
                      'text-[12px] px-2.5 py-1',
                    )}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => dismissToast(toast.id)}
            className="mt-0.5 text-ink-500 transition hover:text-ink-100"
            aria-label="Chiudi notifica"
          >
            <IconClose className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
