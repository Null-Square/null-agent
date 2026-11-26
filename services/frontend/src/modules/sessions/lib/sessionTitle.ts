const SESSION_TITLE_MAX_CHARS = 80;

export const DEFAULT_SESSION_TITLE = 'Untitled Session';
export const DEFAULT_SESSION_DISPLAY = 'UNTITLED SESSION';

const normalizeTitle = (value?: string | null): string => {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim();
};

const truncateTitle = (value: string): string => {
  if (value.length <= SESSION_TITLE_MAX_CHARS) return value;
  return `${value.slice(0, SESSION_TITLE_MAX_CHARS - 3)}...`;
};

export const deriveSessionTitle = (options: {
  title?: string | null;
  taskTitle?: string | null;
  userPrompt?: string | null;
  fallback?: string;
}): string => {
  const {
    title,
    taskTitle,
    userPrompt,
    fallback = DEFAULT_SESSION_TITLE,
  } = options;

  const candidate =
    normalizeTitle(title) ||
    normalizeTitle(taskTitle) ||
    normalizeTitle(userPrompt);

  if (!candidate) {
    return fallback;
  }

  return truncateTitle(candidate);
};

export const getSessionDisplayTitle = (
  session: {
    title?: string | null;
    lastMessage?: string | null;
    task?: { title?: string | null };
  },
  fallback: string = DEFAULT_SESSION_DISPLAY,
): string =>
  deriveSessionTitle({
    title: session.title,
    taskTitle: session.task?.title,
    userPrompt: session.lastMessage,
    fallback,
  });
