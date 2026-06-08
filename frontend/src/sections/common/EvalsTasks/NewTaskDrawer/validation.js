import { getNumberValidation } from "src/utils/validation";
import { z } from "zod";

const RANGE_OPS = new Set(["between", "not_between"]);
const LIST_OPS = new Set(["in", "not_in"]);

// Maps a form-row `property` to the outer-filters-dict sibling key the
// BE honors (see `parsing_evaltask_filters` in tracer/utils/eval_tasks.py).
//
// `node_type` is the FE-side alias for `observation_type`; the SYSTEM_METRIC
// handler doesn't translate it (its DEFAULT_FIELD_MAP entry points at the
// non-existent `node_type` Django field, relying on the caller having
// annotated `node_type=F("observation_type")` the way list_spans_observe
// does at observation_span.py:1617). process_eval_task doesn't replicate
// that annotate, so we route the chip via the BE's direct
// observation_type sibling branch instead.
const TOP_LEVEL_SIBLING_KEY_BY_PROPERTY = {
  observation_type: "observation_type",
  node_type: "observation_type",
  session_id: "session_id",
};

// Column ids the BE always routes via its annotation handler regardless
// of col_type (filters.py:1711-1755 in get_filter_conditions_for_voice_call_annotations).
// Forcing col_type=ANNOTATION on the wire keeps the eval-task dispatcher
// from also feeding the same row to the SPAN_ATTRIBUTE / SYSTEM_METRIC
// handlers — where it'd otherwise match no rows and poison the AND.
const ANNOTATION_COLUMN_IDS = new Set(["annotator", "my_annotations"]);

// fieldCategory → col_type fallback. Used when the form row didn't
// carry an apiColType (e.g. the panel's static system fields at
// TraceFilterPanel.jsx:1650-1666 don't set one). Mirrors the
// PANEL_CAT_TO_COL_TYPE in TaskFilterBar.jsx — duplicated here so the
// wire encoding is correct even if the form-row producer skipped it.
const FIELD_CATEGORY_TO_COL_TYPE = {
  attribute: "SPAN_ATTRIBUTE",
  system: "SYSTEM_METRIC",
  eval: "EVAL_METRIC",
  annotation: "ANNOTATION",
};

// Group multiple form rows for the same (columnId, op) into a single wire
// entry. Scalar rows for list ops collapse to array `filterValue`; multiple
// scalar rows for a single-value op (legacy multi-value `equals` from saved
// tasks) are promoted to `in` so the BE filter validator accepts them.
//
// Mirrors `list_spans_observe`'s shape (observation_span.py:1755-1826):
// every chip — SPAN_ATTRIBUTE, SYSTEM_METRIC, EVAL_METRIC, ANNOTATION,
// has_eval, has_annotation, annotator — goes into the same flat list with
// its own `col_type`. The dispatcher fans out per col_type on the BE.
export const extractAttributeFilters = (filters) => {
  const merged = new Map();
  (filters || [])
    .filter((f) => {
      if (!f) return false;
      // Sibling top-level keys (observation_type, node_type → observation_type,
      // session_id) are emitted separately by `getNewTaskFilters`.
      if (f.property in TOP_LEVEL_SIBLING_KEY_BY_PROPERTY) return false;
      // Hydrated legacy rows with no apiColType and no propertyId are
      // BE no-ops anyway — drop them.
      if (!f.propertyId && f.property !== "attributes") return false;
      return true;
    })
    .forEach((f) => {
      const columnId = f.propertyId || f.property;
      if (!columnId) return;
      const op = f?.filterConfig?.filterOp || "equals";
      const filterType = f?.filterConfig?.filterType || "text";
      const key = `${columnId}|${op}|${filterType}`;
      if (!merged.has(key)) {
        // Resolution order:
        //   1. ANNOTATION_COLUMN_IDS — annotator / my_annotations are
        //      always ANNOTATION regardless of what the panel said.
        //   2. row's explicit apiColType (set by TaskFilterBar via
        //      resolveApiColType — the canonical source).
        //   3. fieldCategory mapping (covers form rows whose
        //      apiColType was lost upstream, e.g. when the panel's
        //      static system fields skipped setting it).
        //   4. SPAN_ATTRIBUTE default (last resort).
        let apiColType;
        if (ANNOTATION_COLUMN_IDS.has(columnId)) {
          apiColType = "ANNOTATION";
        } else if (f?.apiColType) {
          apiColType = f.apiColType;
        } else if (FIELD_CATEGORY_TO_COL_TYPE[f?.fieldCategory]) {
          apiColType = FIELD_CATEGORY_TO_COL_TYPE[f.fieldCategory];
        } else {
          apiColType = "SPAN_ATTRIBUTE";
        }

        merged.set(key, {
          columnId,
          op,
          filterType,
          apiColType,
          rangeValue: undefined,
          values: [],
        });
      }
      const entry = merged.get(key);
      const v = f?.filterConfig?.filterValue;
      if (RANGE_OPS.has(op)) {
        entry.rangeValue = Array.isArray(v) ? v : entry.rangeValue;
      } else if (LIST_OPS.has(op)) {
        const arr = Array.isArray(v)
          ? v
          : v !== undefined && v !== null && v !== ""
            ? [v]
            : [];
        entry.values.push(...arr);
      } else if (v !== undefined && v !== null && v !== "") {
        entry.values.push(v);
      }
    });

  return Array.from(merged.values()).map((entry) => {
    let filterValue;
    let filterOp = entry.op;
    if (RANGE_OPS.has(filterOp)) {
      filterValue = entry.rangeValue;
    } else if (LIST_OPS.has(filterOp)) {
      filterValue = entry.values;
    } else if (entry.values.length > 1) {
      // Multiple scalar rows under a single-value op → promote to `in`.
      filterOp = "in";
      filterValue = entry.values;
    } else if (entry.values.length === 1) {
      filterValue = entry.values[0];
    }
    return {
      columnId: entry.columnId,
      filterConfig: {
        filterType: entry.filterType,
        filterOp,
        colType: entry.apiColType,
        ...(filterValue !== undefined && { filterValue }),
      },
    };
  });
};

// Extract rows whose property maps to a BE-honored sibling top-level key
// (observation_type / node_type → observation_type, session_id). Each
// contributes its values to a flat per-field array on the outer filters
// dict, with the property renamed to the BE-side key when they differ.
const extractSiblingFilters = (filters) => {
  const out = {};
  (filters || []).forEach((f) => {
    const beKey = TOP_LEVEL_SIBLING_KEY_BY_PROPERTY[f?.property];
    if (!beKey) return;
    const val = f?.filterConfig?.filterValue;
    const vals = Array.isArray(val)
      ? val
      : val !== undefined && val !== null && val !== ""
        ? [val]
        : [];
    if (vals.length === 0) return;
    if (out[beKey]) {
      out[beKey].push(...vals);
    } else {
      out[beKey] = [...vals];
    }
  });
  return out;
};

export const getNewTaskFilters = (data, projectId, ignoreDate = false) => {
  const filters = { project_id: projectId?.length ? projectId : null };

  const attributeFilters = extractAttributeFilters(data?.filters);
  Object.assign(filters, extractSiblingFilters(data?.filters));

  if (data?.runType === "historical" && !ignoreDate) {
    filters["date_range"] = [
      new Date(data?.startDate).toISOString(),
      new Date(data?.endDate).toISOString(),
    ];
  }

  return { filters, attributeFilters };
};

export const NewTaskValidationSchema = () =>
  z
    .object({
      name: z.string().min(1, { message: "Name is required" }),
      project: z.string().min(1, { message: "Project is required" }),
      spansLimit: z.union([
        z.string().optional(),
        getNumberValidation("Max Spans is required"),
      ]),
      samplingRate: getNumberValidation("Sampling Rate is required"),
      evalsDetails: z
        .array(z.any())
        .min(1, { message: "At least one evaluation is required" })
        .refine(
          (evals) =>
            evals.every(
              (e) => typeof e?.id === "string" && e.id.length > 0,
            ),
          {
            message:
              "Remove the highlighted evaluation(s) and re-add them before continuing.",
          },
        )
        .transform((evals) => evals.map((e) => e.id)),
      startDate: z.string(),
      endDate: z.string(),
      runType: z.enum(["historical", "continuous"], {
        message: "Run Type is required",
      }),
      // Without listing rowType here, zod's .object() strips it before
      // the transform runs and the form-state value (set by the
      // Spans/Traces/Sessions tabs in TaskConfigPanel) is silently
      // dropped — every payload then defaults to "spans".
      rowType: z
        .enum(["spans", "traces", "sessions", "voiceCalls"])
        .optional(),
      filters: z
        .array(
          z.object({
            id: z.string().optional(),
            propertyId: z.string().optional(),
            property: z.string().optional(),
            filterConfig: z
              .object({
                filterType: z.string().optional(),
                filterOp: z.any().optional(),
                filterValue: z.any().optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .refine(
      (data) => {
        if (data.runType === "historical") {
          return !!data.spansLimit;
        }
        return true;
      },
      {
        message: "Max Spans is required for historical runs",
        path: ["spansLimit"],
      },
    )
    .transform((data) => {
      const { filters, attributeFilters } =
        getNewTaskFilters(data, data?.project) ?? {};

      const finalData = {
        name: data?.name,
        project: data?.project,
        spansLimit: data?.spansLimit,
        samplingRate: data?.samplingRate,
        evals: data?.evalsDetails,
        runType: data?.runType,
        rowType: data?.rowType ?? "spans",
        filters: {
          ...filters,
          ...(attributeFilters && attributeFilters?.length > 0
            ? { filters: attributeFilters }
            : {}),
        },
      };

      return finalData;
    });
