/**
 * What the content-repair judgment eval measured (#6377 section 4,
 * evals/content-repair-judgment/; verdicts in gbrain-evals).
 *
 * `CONTENT_REPAIR_MEASURED_MODELS`: the models that met the preregistered
 * rule (zero hard failures: no `remove_slug` on a true duplicate, no
 * `merge_into` on an unrelated pair or with the wrong canonical; at least 80%
 * `merge_into` with the right canonical on true duplicates), best first,
 * ties to the cheaper model. Until that eval has run it equals the fence
 * repair's measured list (both frontier models); the content-repair eval
 * fills it in its own PR. With `models.content_repair` and
 * `models.fence_repair` unset, the judgment uses the first one the brain has
 * a provider key for; with none, the model tier stays off
 * (`no_measured_model`).
 */
import { FENCE_REPAIR_MEASURED_MODELS } from '../fence-repair/measured.ts';

export const CONTENT_REPAIR_MEASURED_MODELS: readonly string[] = FENCE_REPAIR_MEASURED_MODELS;
