/**
 * Task-related Zod schemas and inferred types.
 * This is the single source of truth for task data structures.
 *
 * @example
 * import { TaskSummary, taskSummarySchema } from '@null-ai/contracts';
 */

import { z } from 'zod';

// ============================================================================
// Task Input Definition
// ============================================================================

export const taskInputComponentSchema = z.enum([
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
  'switch',
  'tags',
  'number',
  'password',
  'file',
  'date',
  'datetime',
  'email',
  'url',
]);

export type TaskInputComponent = z.infer<typeof taskInputComponentSchema>;

export const taskInputValueTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'string[]',
  'file',
]);

export type TaskInputValueType = z.infer<typeof taskInputValueTypeSchema>;

export const taskInputFormatSchema = z.enum([
  'text',
  'domain',
  'ip',
  'cidr',
  'url',
  'email',
]);

export type TaskInputFormat = z.infer<typeof taskInputFormatSchema>;

export const taskInputTypeSchema = taskInputComponentSchema;
export type TaskInputType = z.infer<typeof taskInputTypeSchema>;

export const taskInputOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1).optional(),
  disabled: z.boolean().optional(),
  description: z.string().optional(),
});

export type TaskInputOption = z.infer<typeof taskInputOptionSchema>;

export const taskInputOptionsSchema = z.union([
  z.array(z.string().min(1)),
  z.array(taskInputOptionSchema),
]);

const taskInputDefinitionBaseSchema = z.object({
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  component: taskInputComponentSchema.optional(),
  valueType: taskInputValueTypeSchema.optional(),
  format: taskInputFormatSchema.optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  options: taskInputOptionsSchema.optional(),
  allowCustom: z.boolean().optional(),
  multiple: z.boolean().optional(),
  default: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
  ]).optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  pattern: z.string().optional(),
  accept: z.array(z.string().min(1)).optional(),
  maxSizeBytes: z.number().int().positive().optional(),
  secret: z.boolean().optional(),
});

const requireOptions = (value: z.infer<typeof taskInputDefinitionBaseSchema>) => {
  const component = value.component;
  const needsOptions = component === 'select' || component === 'radio';
  if (!needsOptions) return true;
  return Array.isArray(value.options) && value.options.length > 0;
};

export const taskInputDefinitionSchema = taskInputDefinitionBaseSchema
  .refine((value) => Boolean(value.name), {
    message: 'input name required',
    path: ['name'],
  })
  .refine((value) => Boolean(value.label), {
    message: 'input label required',
    path: ['label'],
  })
  .refine(requireOptions, {
    message: 'select/radio inputs require options',
    path: ['options'],
  });

export const taskInputDefinitionSeedSchema = taskInputDefinitionBaseSchema.refine(requireOptions, {
  message: 'select/radio inputs require options',
  path: ['options'],
});

// Inferred type from schema - name/label optional in schema but guaranteed after normalization
type TaskInputDefinitionInferred = z.infer<typeof taskInputDefinitionSchema>;

// Exported type makes name and label required since normalizeTaskInputDefinition always provides them
export type TaskInputDefinition = Omit<TaskInputDefinitionInferred, 'name' | 'label'> & {
  name: string;
  label: string;
};

export type TaskInputDefinitionSeed = z.infer<typeof taskInputDefinitionSeedSchema>;

export const normalizeTaskInputOptions = (options?: TaskInputDefinitionSeed['options']): TaskInputOption[] | undefined => {
  if (!options) return undefined;
  if (!Array.isArray(options)) return undefined;
  if (options.length === 0) return undefined;

  if (typeof options[0] === 'string') {
    return (options as string[])
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => ({ value, label: value }));
  }

  return (options as TaskInputOption[])
    .map((option) => ({
      ...option,
      label: option.label?.trim() || option.value,
    }))
    .filter((option) => option.value && option.value.trim().length > 0);
};

const deriveComponent = (input: TaskInputDefinitionSeed): TaskInputComponent => {
  if (input.component) return input.component;
  return 'text';
};

const deriveFormat = (input: TaskInputDefinitionSeed, component: TaskInputComponent): TaskInputFormat | undefined => {
  if (input.format) return input.format;
  if (component === 'url') return 'url';
  if (component === 'email') return 'email';
  return undefined;
};

const deriveValueType = (input: TaskInputDefinitionSeed, component: TaskInputComponent): TaskInputValueType => {
  if (input.valueType) return input.valueType;
  if (component === 'switch' || component === 'checkbox') return 'boolean';
  if (component === 'file') return 'file';
  if (component === 'number') return 'number';
  if (component === 'tags') return 'string[]';
  if (component === 'select' && input.multiple) return 'string[]';
  return 'string';
};

export const normalizeTaskInputDefinition = (
  name: string,
  input: TaskInputDefinitionSeed,
): TaskInputDefinition => {
  const normalizedName = input.name?.trim() || name.trim();
  const label = input.label?.trim() || normalizedName;
  const component = deriveComponent(input);
  const format = deriveFormat(input, component);
  const valueType = deriveValueType(input, component);
  const options = normalizeTaskInputOptions(input.options);
  const multiple = typeof input.multiple === 'boolean' ? input.multiple : component === 'tags';

  return {
    name: normalizedName,
    label,
    component,
    valueType,
    format,
    required: input.required,
    placeholder: input.placeholder,
    help: input.help,
    options,
    allowCustom: input.allowCustom,
    multiple,
    default: input.default,
    minLength: input.minLength,
    maxLength: input.maxLength,
    min: input.min,
    max: input.max,
    step: input.step,
    pattern: input.pattern,
    accept: input.accept,
    maxSizeBytes: input.maxSizeBytes,
    secret: input.secret,
  };
};

export const normalizeTaskInputDefinitions = (
  inputs: Record<string, unknown> | TaskInputDefinitionSeed[] | undefined,
): TaskInputDefinition[] => {
  if (!inputs) return [];

  if (Array.isArray(inputs)) {
    return inputs
      .filter((definition): definition is TaskInputDefinitionSeed => Boolean(definition && typeof definition === 'object'))
      .map((definition) => {
        const name = typeof definition.name === 'string' ? definition.name : '';
        return normalizeTaskInputDefinition(name, definition);
      })
      .filter((definition) => definition.name && definition.name.length > 0);
  }

  if (typeof inputs !== 'object') return [];

  return Object.entries(inputs)
    .filter(([name, definition]) => Boolean(name) && definition && typeof definition === 'object')
    .map(([name, definition]) => normalizeTaskInputDefinition(name, definition as TaskInputDefinitionSeed));
};

// ============================================================================
// Task Summary (for catalog listings)
// ============================================================================

export const taskSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.string().optional(),
  summary: z.string().optional(),
  icon: z.string().optional(),
  versionHash: z.string().optional(),
  inputs: z.array(taskInputDefinitionSchema).optional(),
  creditsEstimate: z.number().int().positive().optional(),
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;

// ============================================================================
// Plan Blueprint Step
// ============================================================================

export const planBlueprintStepSchema = z.object({
  step: z.string().min(1),
  action: z.string().min(1),
  label: z.string().optional(),
  args: z.record(z.unknown()).optional(),
});

export type PlanBlueprintStep = z.infer<typeof planBlueprintStepSchema>;

// ============================================================================
// Task Manifest (full task definition)
// ============================================================================

export const taskManifestSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  category: z.string().optional(),
  summary: z.string().optional(),
  icon: z.string().optional(),
  inputs: z.record(taskInputDefinitionSeedSchema),
  instructions: z.record(z.unknown()).optional(),
  denyTools: z.array(z.string()).optional(),
  requires: z.array(z.string()).optional(),
  planBlueprint: z.array(planBlueprintStepSchema).default([]),
  sandbox: z.object({
    capabilityProfile: z.string().optional(),
    image: z.string().optional(),
    imageId: z.string().optional(),
  }).optional(),
  policy: z.string().optional(),
  creditsEstimate: z.number().int().positive().optional(),
});

export type TaskManifest = z.infer<typeof taskManifestSchema>;

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate an array of task summaries, returning only valid items.
 * Invalid items are logged but not thrown.
 */
export const validateTaskSummaries = (data: unknown): TaskSummary[] => {
  if (!Array.isArray(data)) return [];

  return data
    .map((item) => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const inputs = normalizeTaskInputDefinitions(raw.inputs as Record<string, unknown> | TaskInputDefinitionSeed[] | undefined);
      const candidate = {
        ...raw,
        inputs: inputs.length > 0 ? inputs : undefined,
      };
      const result = taskSummarySchema.safeParse(candidate);
      if (result.success) return result.data;
      console.warn('[validateTaskSummaries] Invalid item:', result.error.message);
      return null;
    })
    .filter((item): item is TaskSummary => item !== null);
};

/**
 * Validate a task manifest.
 */
export const validateTaskManifest = (data: unknown): TaskManifest | null => {
  const result = taskManifestSchema.safeParse(data);
  if (result.success) return result.data;
  console.warn('[validateTaskManifest] Invalid:', result.error.message);
  return null;
};
