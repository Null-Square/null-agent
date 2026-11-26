import { isValidElement, type ReactNode } from 'react';
import { toast, type ExternalToast } from 'sonner';

export type ToastId = string | number;
export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastAction {
  label: ReactNode;
  onClick: () => void;
}

export type ToastOptions = Omit<ExternalToast, 'description' | 'action'> & {
  description?: ReactNode;
  action?: ToastAction;
};

type ToastDescriptionOrOptions = ReactNode | ToastOptions;

type ToastPromiseMessages<T> = {
  loading?: ReactNode;
  success?: ReactNode | ((data: T) => ReactNode | Promise<ReactNode>);
  error?: ReactNode | ((error: unknown) => ReactNode | Promise<ReactNode>);
  description?: ReactNode;
  finally?: () => void | Promise<void>;
};

type ShowToastOptions = ToastOptions & {
  title: ReactNode;
  variant?: 'default' | 'destructive';
  type?: ToastType;
};

const isToastOptions = (value: ToastDescriptionOrOptions | undefined): value is ToastOptions => {
  if (!value || typeof value !== 'object' || isValidElement(value) || Array.isArray(value)) {
    return false;
  }

  return true;
};

const toSonnerOptions = (
  descriptionOrOptions?: ToastDescriptionOrOptions,
  options?: ToastOptions,
): ExternalToast => {
  const baseOptions = isToastOptions(descriptionOrOptions)
    ? descriptionOrOptions
    : descriptionOrOptions !== undefined
      ? { description: descriptionOrOptions }
      : {};
  const merged = { ...baseOptions, ...options };
  const { action, ...sonnerOptions } = merged;

  return {
    ...sonnerOptions,
    action: action
      ? {
          label: action.label,
          onClick: () => action.onClick(),
        }
      : undefined,
  };
};

const notify = (
  type: ToastType,
  title: ReactNode,
  descriptionOrOptions?: ToastDescriptionOrOptions,
  options?: ToastOptions,
) => {
  const sonnerOptions = toSonnerOptions(descriptionOrOptions, options);

  switch (type) {
    case 'success':
      return toast.success(title, sonnerOptions);
    case 'error':
      return toast.error(title, sonnerOptions);
    case 'warning':
      return toast.warning(title, sonnerOptions);
    case 'info':
    default:
      return toast.info(title, sonnerOptions);
  }
};

export const toastService = {
  success: (title: ReactNode, descriptionOrOptions?: ToastDescriptionOrOptions, options?: ToastOptions) =>
    notify('success', title, descriptionOrOptions, options),

  error: (title: ReactNode, descriptionOrOptions?: ToastDescriptionOrOptions, options?: ToastOptions) =>
    notify('error', title, descriptionOrOptions, options),

  info: (title: ReactNode, descriptionOrOptions?: ToastDescriptionOrOptions, options?: ToastOptions) =>
    notify('info', title, descriptionOrOptions, options),

  warning: (title: ReactNode, descriptionOrOptions?: ToastDescriptionOrOptions, options?: ToastOptions) =>
    notify('warning', title, descriptionOrOptions, options),

  show: ({ title, variant, type, ...options }: ShowToastOptions) => {
    const toastType = type ?? (variant === 'destructive' ? 'error' : 'info');
    return notify(toastType, title, undefined, options);
  },

  message: (title: ReactNode, descriptionOrOptions?: ToastDescriptionOrOptions, options?: ToastOptions) =>
    toast.message(title, toSonnerOptions(descriptionOrOptions, options)),

  promise: <T>(
    promise: Promise<T> | (() => Promise<T>),
    messages: ToastPromiseMessages<T>,
    options?: ToastOptions,
  ) => toast.promise(promise, { ...toSonnerOptions(options), ...messages }),

  dismiss: (id?: ToastId) => toast.dismiss(id),
};
