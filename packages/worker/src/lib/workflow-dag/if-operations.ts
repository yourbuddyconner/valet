export type IfDataType = 'string' | 'number' | 'date' | 'boolean' | 'array' | 'object';

const OPERATION_ALIASES: Record<string, string> = {
  does_not_exist: 'doesNotExist',
  is_empty: 'isEmpty',
  is_not_empty: 'isNotEmpty',
  not_equals: 'notEquals',
  does_not_contain: 'doesNotContain',
  starts_with: 'startsWith',
  ends_with: 'endsWith',
  matches_regex: 'matchesRegex',
  greater_than: 'greaterThan',
  less_than: 'lessThan',
  greater_than_or_equal: 'greaterThanOrEqual',
  less_than_or_equal: 'lessThanOrEqual',
  after_or_equal: 'afterOrEqual',
  before_or_equal: 'beforeOrEqual',
  is_true: 'isTrue',
  is_false: 'isFalse',
  length_equals: 'lengthEquals',
  length_greater_than: 'lengthGreaterThan',
  length_less_than: 'lengthLessThan',
};

const OPERATIONS_BY_TYPE: Record<IfDataType, readonly string[]> = {
  string: [
    'exists',
    'doesNotExist',
    'isEmpty',
    'isNotEmpty',
    'equals',
    'notEquals',
    'contains',
    'doesNotContain',
    'startsWith',
    'endsWith',
    'matchesRegex',
  ],
  number: [
    'exists',
    'doesNotExist',
    'isEmpty',
    'isNotEmpty',
    'equals',
    'notEquals',
    'greaterThan',
    'lessThan',
    'greaterThanOrEqual',
    'lessThanOrEqual',
  ],
  date: [
    'exists',
    'doesNotExist',
    'equals',
    'notEquals',
    'after',
    'before',
    'afterOrEqual',
    'beforeOrEqual',
  ],
  boolean: [
    'exists',
    'doesNotExist',
    'isTrue',
    'isFalse',
    'equals',
    'notEquals',
  ],
  array: [
    'exists',
    'doesNotExist',
    'isEmpty',
    'isNotEmpty',
    'contains',
    'doesNotContain',
    'lengthEquals',
    'lengthGreaterThan',
    'lengthLessThan',
  ],
  object: [
    'exists',
    'doesNotExist',
    'isEmpty',
    'isNotEmpty',
  ],
};

export function normalizeIfOperation(operation: string): string {
  return OPERATION_ALIASES[operation] ?? operation;
}

export function isIfOperationSupported(dataType: IfDataType, operation: string): boolean {
  return OPERATIONS_BY_TYPE[dataType].includes(normalizeIfOperation(operation));
}

export function allowedIfOperations(dataType: IfDataType): readonly string[] {
  return OPERATIONS_BY_TYPE[dataType];
}
