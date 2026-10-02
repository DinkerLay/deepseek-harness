/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  origin: '成员 {subject} · Task {task}',
  unknownTask: '未确定',
  unavailableOperation: '无法确认成员的原始操作详情，只能拒绝。',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  origin: 'Member {subject} · Task {task}',
  unknownTask: 'undetermined',
  unavailableOperation: 'The original member operation could not be verified. Only rejection is available.',
} satisfies Record<ApprovalKey, string>
