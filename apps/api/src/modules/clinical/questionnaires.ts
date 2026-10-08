import { limitOf, page, toDto, toDtos } from "../../platform/dto.js";
import type { HandlerMap } from "../../platform/http/context.js";
import { requirePatient } from "../../platform/patientAccess.js";
import { notFound, unprocessable, validationFailed } from "../../platform/problem.js";
import { loadEncounter } from "../encounters/access.js";
import { type QuestionItem, type Scoring, scoreResponse } from "./domain.js";

/**
 * Screenings and forms (encounter.rooming PHQ-2/9 and SDOH, intake). Answers are {linkId: answer code}; the server
 * scores them from the questionnaire's own scoring bands, so a score is never typed in by hand.
 */

export const questionnaireHandlers: HandlerMap = {
  async listQuestionnaires(ctx) {
    const q = ctx.query;
    const rows = await ctx.db.questionnaire.findMany({
      where: {
        ...(q.category ? { purpose: q.category } : {}),
        status: q.status?.length ? { in: q.status } : "active",
      },
      orderBy: { name: "asc" },
    });
    return toDtos("Questionnaire", rows);
  },

  async getQuestionnaire(ctx) {
    const row = await ctx.db.questionnaire.findUnique({
      where: { id: ctx.params.questionnaireId },
    });
    if (!row) throw notFound();
    return toDto("Questionnaire", row);
  },

  async submitQuestionnaireResponse(ctx) {
    const b = ctx.body;
    const patient = await requirePatient(ctx, ctx.params.patientId);
    if (b.patientId !== patient.id)
      throw unprocessable("validation_failed", "The response must be for this patient.");
    const qn = await ctx.db.questionnaire.findUnique({ where: { id: b.questionnaireId } });
    if (!qn || qn.status !== "active")
      throw unprocessable("validation_failed", "Choose an active form.");
    if (b.encounterId) {
      const enc = await loadEncounter(ctx, b.encounterId);
      if (enc.patientId !== patient.id)
        throw unprocessable("validation_failed", "That visit is for another patient.");
    }
    const items = (qn.items ?? []) as unknown as QuestionItem[];
    const answers = (b.answers ?? {}) as Record<string, string>;
    if (typeof answers !== "object" || Array.isArray(answers))
      throw unprocessable("validation_failed", "Answers are missing.");
    const missing = items.filter((i) => i.answerOption && !answers[i.linkId]);
    if (missing.length && (b.status ?? "completed") === "completed")
      throw validationFailed(
        missing.map((i) => ({ field: i.linkId, code: "required", message: `Answer "${i.text}".` })),
        "Answer every question, or save it as in progress.",
      );
    for (const i of items) {
      const a = answers[i.linkId];
      if (a && i.answerOption && !i.answerOption.some((o) => o.code === a))
        throw validationFailed([
          {
            field: i.linkId,
            code: "invalid",
            message: `Choose one of the listed answers for "${i.text}".`,
          },
        ]);
    }
    const { score } = scoreResponse(items, answers, (qn.scoring ?? null) as Scoring | null);
    const row = await ctx.db.questionnaireResponse.create({
      data: {
        practiceId: patient.practiceId,
        questionnaireId: qn.id,
        patientId: patient.id,
        encounterId: b.encounterId ?? null,
        status: b.status ?? "completed",
        answers,
        score,
        authoredAt: b.authoredAt ? new Date(b.authoredAt) : new Date(),
      },
    });
    ctx.audit.resource("QuestionnaireResponse", row.id);
    return toDto("QuestionnaireResponse", row);
  },

  async listQuestionnaireResponses(ctx) {
    const q = ctx.query;
    await requirePatient(ctx, ctx.params.patientId);
    const limit = limitOf(q);
    const rows = await ctx.db.questionnaireResponse.findMany({
      where: {
        patientId: ctx.params.patientId,
        stagingStatus: "ACTIVE",
        ...(q.category ? { questionnaire: { purpose: q.category } } : {}),
        ...(q.cursor ? { authoredAt: { lt: new Date(q.cursor) } } : {}),
      },
      orderBy: { authoredAt: "desc" },
      take: limit + 1,
    });
    ctx.audit.detail({ rows: rows.length });
    return page(
      rows,
      limit,
      (r) => toDto("QuestionnaireResponse", r),
      (r) => r.authoredAt.toISOString(),
    );
  },
};
