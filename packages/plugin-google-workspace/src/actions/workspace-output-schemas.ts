import type { ActionDefinition } from '@valet/sdk';

type JsonSchema = Record<string, unknown>;

const scalarValueSchema: JsonSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ],
};

const stringSchema: JsonSchema = { type: 'string' };
const numberSchema: JsonSchema = { type: 'number' };
const integerSchema: JsonSchema = { type: 'integer' };
const booleanSchema: JsonSchema = { type: 'boolean' };
const nullableStringSchema: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableNumberSchema: JsonSchema = { anyOf: [{ type: 'number' }, { type: 'null' }] };

const stringArraySchema: JsonSchema = {
  type: 'array',
  items: stringSchema,
};

const tableValuesSchema: JsonSchema = {
  type: 'array',
  items: {
    type: 'array',
    items: scalarValueSchema,
  },
};

const genericObjectSchema: JsonSchema = {
  type: 'object',
  additionalProperties: true,
};

const messageSchema: JsonSchema = {
  type: 'object',
  properties: {
    message: stringSchema,
  },
  required: ['message'],
  additionalProperties: true,
};

const driveFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: stringSchema,
    name: stringSchema,
    mimeType: stringSchema,
    size: stringSchema,
    createdTime: stringSchema,
    modifiedTime: stringSchema,
    webViewLink: stringSchema,
    url: stringSchema,
    owners: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          displayName: stringSchema,
          emailAddress: stringSchema,
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

const driveFileListSchema = (property: 'files' | 'documents' | 'folders'): JsonSchema => ({
  type: 'object',
  properties: {
    [property]: {
      type: 'array',
      items: driveFileSchema,
    },
    total: integerSchema,
    nextPageToken: stringSchema,
    hasMore: booleanSchema,
  },
  required: [property],
  additionalProperties: true,
});

const driveCreatedFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: stringSchema,
    name: stringSchema,
    url: stringSchema,
    webViewLink: stringSchema,
    mimeType: stringSchema,
    parents: stringArraySchema,
  },
  required: ['id', 'name'],
  additionalProperties: true,
};

const driveDownloadSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: stringSchema,
    mimeType: stringSchema,
    exportedAs: stringSchema,
    content: stringSchema,
  },
  required: ['name', 'mimeType', 'content'],
  additionalProperties: true,
};

const driveDeleteSchema: JsonSchema = {
  type: 'object',
  properties: {
    trashed: booleanSchema,
    permanentlyDeleted: booleanSchema,
  },
  required: ['trashed', 'permanentlyDeleted'],
  additionalProperties: false,
};

const driveInfoSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: stringSchema,
    name: stringSchema,
    mimeType: stringSchema,
    createdTime: stringSchema,
    modifiedTime: stringSchema,
    owner: nullableStringSchema,
    lastModifyingUser: nullableStringSchema,
    shared: booleanSchema,
    url: stringSchema,
    description: nullableStringSchema,
    parentFolderId: nullableStringSchema,
    childCount: nullableNumberSchema,
  },
  required: ['id', 'name'],
  additionalProperties: true,
};

const docsContentSchema: JsonSchema = {
  type: 'object',
  properties: {
    content: stringSchema,
  },
  required: ['content'],
  additionalProperties: true,
};

const docsTabSchema: JsonSchema = {
  type: 'object',
  properties: {
    tabId: stringSchema,
    title: stringSchema,
    index: integerSchema,
  },
  additionalProperties: true,
};

const docsCommentSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: stringSchema,
    author: nullableStringSchema,
    content: stringSchema,
    quotedText: nullableStringSchema,
    resolved: booleanSchema,
    createdTime: stringSchema,
    replyCount: integerSchema,
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: stringSchema,
          author: nullableStringSchema,
          content: stringSchema,
          createdTime: stringSchema,
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};

const docsTabsSchema: JsonSchema = {
  type: 'object',
  properties: {
    documentTitle: stringSchema,
    tabs: {
      type: 'array',
      items: docsTabSchema,
    },
  },
  required: ['tabs'],
  additionalProperties: true,
};

const docsCommentsSchema: JsonSchema = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: docsCommentSchema,
    },
  },
  required: ['comments'],
  additionalProperties: true,
};

const docsTextIndexSchema: JsonSchema = {
  type: 'object',
  properties: {
    startIndex: integerSchema,
    endIndex: integerSchema,
    text: stringSchema,
    instance: integerSchema,
    message: stringSchema,
  },
  required: ['startIndex', 'endIndex', 'text', 'instance', 'message'],
  additionalProperties: true,
};

const sheetPropertiesSchema: JsonSchema = {
  type: 'object',
  properties: {
    sheetId: integerSchema,
    title: stringSchema,
    index: integerSchema,
    rows: integerSchema,
    columns: integerSchema,
    hidden: booleanSchema,
  },
  additionalProperties: true,
};

const spreadsheetFileSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: stringSchema,
    name: stringSchema,
    modifiedTime: stringSchema,
    url: stringSchema,
  },
  required: ['id', 'name'],
  additionalProperties: true,
};

const spreadsheetInfoSchema: JsonSchema = {
  type: 'object',
  properties: {
    title: stringSchema,
    spreadsheetId: stringSchema,
    url: stringSchema,
    sheets: {
      type: 'array',
      items: sheetPropertiesSchema,
    },
  },
  required: ['spreadsheetId', 'sheets'],
  additionalProperties: true,
};

const spreadsheetListSchema: JsonSchema = {
  type: 'object',
  properties: {
    spreadsheets: {
      type: 'array',
      items: spreadsheetFileSchema,
    },
  },
  required: ['spreadsheets'],
  additionalProperties: true,
};

const sheetValuesSchema: JsonSchema = {
  type: 'object',
  properties: {
    range: stringSchema,
    values: tableValuesSchema,
  },
  required: ['range', 'values'],
  additionalProperties: true,
};

const sheetWriteResultSchema: JsonSchema = {
  type: 'object',
  properties: {
    spreadsheetId: stringSchema,
    tableRange: stringSchema,
    updatedRange: stringSchema,
    updatedRows: integerSchema,
    updatedColumns: integerSchema,
    updatedCells: integerSchema,
    updates: genericObjectSchema,
  },
  additionalProperties: true,
};

const rangeSchema = (property = 'range'): JsonSchema => ({
  type: 'object',
  properties: {
    [property]: stringSchema,
  },
  required: [property],
  additionalProperties: true,
});

const deletedSchema = (idField: string): JsonSchema => ({
  type: 'object',
  properties: {
    [idField]: idField.endsWith('Id') ? integerSchema : stringSchema,
    deleted: booleanSchema,
  },
  required: [idField, 'deleted'],
  additionalProperties: true,
});

const sheetsTableSchema: JsonSchema = {
  type: 'object',
  properties: {
    tableId: stringSchema,
    name: stringSchema,
    range: stringSchema,
    headerRowIndex: integerSchema,
    columns: {
      type: 'array',
      items: genericObjectSchema,
    },
  },
  additionalProperties: true,
};

const sheetsTableListSchema: JsonSchema = {
  type: 'object',
  properties: {
    count: integerSchema,
    tables: {
      type: 'array',
      items: sheetsTableSchema,
    },
  },
  required: ['tables'],
  additionalProperties: true,
};

const conditionalFormattingRulesSchema: JsonSchema = {
  type: 'object',
  properties: {
    sheetName: nullableStringSchema,
    count: integerSchema,
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: integerSchema,
          kind: stringSchema,
          ranges: stringArraySchema,
          conditionType: nullableStringSchema,
          conditionValues: stringArraySchema,
          backgroundColor: nullableStringSchema,
          textColor: nullableStringSchema,
          bold: booleanSchema,
          italic: booleanSchema,
        },
        additionalProperties: true,
      },
    },
  },
  required: ['rules'],
  additionalProperties: true,
};

const workspaceOutputSchemas: Record<string, JsonSchema> = {
  'drive.list_files': driveFileListSchema('files'),
  'drive.search_files': driveFileListSchema('files'),
  'drive.list_documents': driveFileListSchema('documents'),
  'drive.search_documents': driveFileListSchema('documents'),
  'drive.list_folder_contents': {
    type: 'object',
    properties: {
      folders: { type: 'array', items: driveFileSchema },
      files: { type: 'array', items: driveFileSchema },
      nextPageToken: stringSchema,
    },
    required: ['folders', 'files'],
    additionalProperties: true,
  },
  'drive.get_document_info': driveInfoSchema,
  'drive.get_folder_info': driveInfoSchema,
  'drive.create_document': driveCreatedFileSchema,
  'drive.create_folder': driveCreatedFileSchema,
  'drive.copy_file': driveCreatedFileSchema,
  'drive.move_file': driveCreatedFileSchema,
  'drive.rename_file': driveCreatedFileSchema,
  'drive.delete_file': driveDeleteSchema,
  'drive.download_file': driveDownloadSchema,
  'drive.create_from_template': driveCreatedFileSchema,

  'docs.read_document': docsContentSchema,
  'docs.insert_text': messageSchema,
  'docs.append_text': messageSchema,
  'docs.modify_text': messageSchema,
  'docs.delete_range': messageSchema,
  'docs.find_and_replace': {
    type: 'object',
    properties: {
      message: stringSchema,
      occurrencesChanged: integerSchema,
    },
    required: ['message', 'occurrencesChanged'],
    additionalProperties: true,
  },
  'docs.append_markdown': messageSchema,
  'docs.replace_document_with_markdown': messageSchema,
  'docs.insert_table': messageSchema,
  'docs.insert_table_with_data': messageSchema,
  'docs.insert_image': messageSchema,
  'docs.insert_page_break': messageSchema,
  'docs.insert_section_break': messageSchema,
  'docs.add_tab': messageSchema,
  'docs.list_tabs': docsTabsSchema,
  'docs.rename_tab': messageSchema,
  'docs.apply_text_style': messageSchema,
  'docs.apply_paragraph_style': messageSchema,
  'docs.update_section_style': messageSchema,
  'docs.list_comments': docsCommentsSchema,
  'docs.get_comment': docsCommentSchema,
  'docs.add_comment': messageSchema,
  'docs.reply_to_comment': messageSchema,
  'docs.delete_comment': messageSchema,
  'docs.resolve_comment': messageSchema,
  'docs.find_text_index': docsTextIndexSchema,

  'sheets.read_spreadsheet': sheetValuesSchema,
  'sheets.write_spreadsheet': sheetWriteResultSchema,
  'sheets.append_rows': sheetWriteResultSchema,
  'sheets.create_spreadsheet': spreadsheetInfoSchema,
  'sheets.get_spreadsheet_info': spreadsheetInfoSchema,
  'sheets.list_spreadsheets': spreadsheetListSchema,
  'sheets.batch_write': sheetWriteResultSchema,
  'sheets.clear_range': rangeSchema('clearedRange'),
  'sheets.add_sheet': sheetPropertiesSchema,
  'sheets.delete_sheet': genericObjectSchema,
  'sheets.rename_sheet': sheetPropertiesSchema,
  'sheets.duplicate_sheet': sheetPropertiesSchema,
  'sheets.copy_sheet_to': sheetPropertiesSchema,
  'sheets.format_cells': rangeSchema('updatedRange'),
  'sheets.read_cell_format': {
    type: 'object',
    properties: {
      range: stringSchema,
      cells: {
        type: 'array',
        items: genericObjectSchema,
      },
    },
    required: ['range', 'cells'],
    additionalProperties: true,
  },
  'sheets.copy_formatting': {
    type: 'object',
    properties: {
      source: stringSchema,
      destination: stringSchema,
    },
    required: ['source', 'destination'],
    additionalProperties: true,
  },
  'sheets.set_column_widths': {
    type: 'object',
    properties: {
      columnWidths: genericObjectSchema,
    },
    required: ['columnWidths'],
    additionalProperties: true,
  },
  'sheets.set_row_heights': {
    type: 'object',
    properties: {
      rowHeights: genericObjectSchema,
    },
    required: ['rowHeights'],
    additionalProperties: true,
  },
  'sheets.auto_resize_columns': rangeSchema('columns'),
  'sheets.auto_resize_rows': rangeSchema('rows'),
  'sheets.set_cell_borders': rangeSchema(),
  'sheets.freeze_rows_and_columns': {
    type: 'object',
    properties: {
      frozenRowCount: integerSchema,
      frozenColumnCount: integerSchema,
    },
    additionalProperties: true,
  },
  'sheets.create_table': sheetsTableSchema,
  'sheets.get_table': sheetsTableSchema,
  'sheets.list_tables': sheetsTableListSchema,
  'sheets.delete_table': {
    type: 'object',
    properties: {
      tableId: stringSchema,
      deleted: booleanSchema,
      dataCleared: booleanSchema,
    },
    required: ['tableId', 'deleted'],
    additionalProperties: true,
  },
  'sheets.update_table_range': sheetsTableSchema,
  'sheets.append_table_rows': sheetWriteResultSchema,
  'sheets.group_rows': rangeSchema('rows'),
  'sheets.ungroup_all_rows': {
    type: 'object',
    properties: {
      levelsRemoved: integerSchema,
    },
    required: ['levelsRemoved'],
    additionalProperties: true,
  },
  'sheets.insert_chart': {
    type: 'object',
    properties: {
      chartId: integerSchema,
    },
    additionalProperties: true,
  },
  'sheets.delete_chart': deletedSchema('chartId'),
  'sheets.add_conditional_formatting': rangeSchema(),
  'sheets.delete_conditional_formatting': {
    type: 'object',
    properties: {
      sheetId: integerSchema,
      index: integerSchema,
      deleted: booleanSchema,
    },
    required: ['sheetId', 'index', 'deleted'],
    additionalProperties: true,
  },
  'sheets.get_conditional_formatting': conditionalFormattingRulesSchema,
  'sheets.set_dropdown_validation': {
    type: 'object',
    properties: {
      range: stringSchema,
      action: stringSchema,
      optionCount: integerSchema,
    },
    required: ['range', 'action'],
    additionalProperties: true,
  },
  'sheets.protect_range': {
    type: 'object',
    properties: {
      protectedRangeId: integerSchema,
      range: stringSchema,
      warningOnly: booleanSchema,
    },
    required: ['range', 'warningOnly'],
    additionalProperties: true,
  },
};

export function withGoogleWorkspaceOutputSchemas(actions: ActionDefinition[]): ActionDefinition[] {
  return actions.map((action) => {
    const outputSchema = workspaceOutputSchemas[action.id];
    if (!outputSchema || action.outputSchema) return action;
    return { ...action, outputSchema };
  });
}

