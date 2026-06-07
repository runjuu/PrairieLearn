import type { QuestionCaller } from '../../question-servers/types.js';
import { type QuestionJson, defaultWorkspaceOptions } from '../../schemas/index.js';
import type { Course, Question, Variant } from '../db-types.js';

import type { QuestionPreviewQid } from './qid.js';

const PREVIEW_COURSE_ID = '1';
const PREVIEW_QUESTION_ID = '1';
const PREVIEW_USER_ID = '1';
const DEFAULT_PREVIEW_VARIANT_ID = '1';

export interface LocalPreviewQuestionRows {
  caller: QuestionCaller;
  course: Course;
  question: Question;
}

interface MakeLocalPreviewQuestionRowsParams {
  courseDir: string;
  info: QuestionJson;
  qid: QuestionPreviewQid;
}

interface LocalPreviewVariantData {
  broken: boolean;
  options: Record<string, unknown>;
  params: Record<string, unknown>;
  preferences: Record<string, string | number | boolean>;
  true_answer: Record<string, unknown>;
}

function normalizeExternalEntrypoint(entrypoint: string | string[] | undefined): string | null {
  if (entrypoint == null) return null;
  if (Array.isArray(entrypoint)) return entrypoint.join(' ');
  return entrypoint;
}

function normalizeWorkspaceArgs(args: string | string[] | undefined): string | null {
  if (args == null) return null;
  if (Array.isArray(args)) return args.join(' ');
  return args;
}

function makeLocalPreviewCourse(courseDir: string): Course {
  const now = new Date();

  return {
    ai_grading_free_credit_redemptions_used: 0,
    announcement_color: null,
    announcement_html: null,
    branch: 'preview-render',
    commit_hash: null,
    course_instance_enrollment_limit: null,
    created_at: now,
    deleted_at: null,
    display_timezone: 'America/Vancouver',
    draft_number: 0,
    example_course: false,
    id: PREVIEW_COURSE_ID,
    institution_id: '1',
    json_comment: null,
    options: {},
    path: courseDir,
    questions_receive_user_data: false,
    repository: null,
    sharing_name: null,
    sharing_token: 'preview-render',
    short_name: 'preview-render',
    show_getting_started: false,
    sync_errors: null,
    sync_job_sequence_id: null,
    sync_warnings: null,
    template_course: false,
    title: 'Preview render course',
    yearly_enrollment_limit: null,
  };
}

function makeLocalPreviewQuestionCaller(course: Course): QuestionCaller {
  return {
    groupId: null,
    userId: null,
    variantCourse: { id: course.id },
  };
}

function makeLocalPreviewQuestion(qid: QuestionPreviewQid, info: QuestionJson): Question {
  const workspaceOptions = info.workspaceOptions ?? defaultWorkspaceOptions;
  const partialCredit = info.partialCredit ?? (info.type === 'v3' ? true : false);

  return {
    client_files: info.clientFiles,
    course_id: PREVIEW_COURSE_ID,
    deleted_at: null,
    dependencies: info.dependencies,
    directory: qid.decoded,
    draft: false,
    external_grading_enable_networking: info.externalGradingOptions?.enableNetworking ?? false,
    external_grading_entrypoint: normalizeExternalEntrypoint(
      info.externalGradingOptions?.entrypoint,
    ),
    external_grading_environment: info.externalGradingOptions?.environment ?? {},
    external_grading_files: info.externalGradingOptions?.serverFilesCourse ?? [],
    external_grading_image: info.externalGradingOptions?.image ?? null,
    external_grading_timeout: info.externalGradingOptions?.timeout ?? null,
    grading_method: info.gradingMethod,
    id: PREVIEW_QUESTION_ID,
    json_comment: info.comment ?? null,
    json_external_grading_comment: info.externalGradingOptions?.comment ?? null,
    json_workspace_comment: workspaceOptions.comment ?? null,
    number: null,
    options: info.options ?? null,
    partial_credit: partialCredit,
    preferences_schema: info.preferences ?? null,
    qid: qid.decoded,
    share_publicly: info.sharePublicly,
    share_source_publicly: info.shareSourcePublicly,
    show_correct_answer: info.showCorrectAnswer,
    single_variant: info.singleVariant,
    sync_errors: null,
    sync_job_sequence_id: null,
    sync_warnings: null,
    template_directory: info.template ?? null,
    title: info.title,
    topic_id: null,
    type: info.type === 'v3' ? 'Freeform' : info.type,
    uuid: info.uuid,
    workspace_args: normalizeWorkspaceArgs(workspaceOptions.args),
    workspace_enable_networking: workspaceOptions.enableNetworking,
    workspace_environment: workspaceOptions.environment,
    workspace_graded_files: workspaceOptions.gradedFiles,
    workspace_home: workspaceOptions.home ?? null,
    workspace_image: workspaceOptions.image ?? null,
    workspace_port: workspaceOptions.port ?? null,
    workspace_url_rewrite: workspaceOptions.rewriteUrl,
  };
}

export function makeLocalPreviewQuestionRows({
  courseDir,
  info,
  qid,
}: MakeLocalPreviewQuestionRowsParams): LocalPreviewQuestionRows {
  const course = makeLocalPreviewCourse(courseDir);
  const question = makeLocalPreviewQuestion(qid, info);

  return {
    caller: makeLocalPreviewQuestionCaller(course),
    course,
    question,
  };
}

export function makeLocalPreviewVariant(
  variantSeed: string,
  data: LocalPreviewVariantData,
  { id = DEFAULT_PREVIEW_VARIANT_ID }: { id?: string } = {},
): Variant {
  const now = new Date();

  return {
    authn_user_id: PREVIEW_USER_ID,
    broken: data.broken,
    broken_at: data.broken ? now : null,
    broken_by: data.broken ? PREVIEW_USER_ID : null,
    client_fingerprint_id: null,
    course_id: PREVIEW_COURSE_ID,
    course_instance_id: null,
    date: now,
    duration: null,
    first_duration: null,
    id,
    instance_question_id: null,
    modified_at: now,
    num_tries: 0,
    number: 1,
    open: true,
    options: data.options,
    params: data.params,
    preferences: data.preferences,
    question_id: PREVIEW_QUESTION_ID,
    team_id: null,
    true_answer: data.true_answer,
    user_id: PREVIEW_USER_ID,
    variant_seed: variantSeed,
    workspace_id: null,
  };
}
