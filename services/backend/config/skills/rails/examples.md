# Rails Examples

## Rails-Specific Evidence

- A controller loads a synthetic record with `Model.find(params[:id])` and skips the policy scope used by its index; evaluator A receives evaluator B's canary.
- Strong parameters permit `role` for a disposable evaluator update and the model persists it despite the UI omitting the field.
- A signed identifier is verified over one canonical form while the controller consumes a duplicate parameter chosen by Rack differently.

## False Positives

- `secret_key_base` is a placeholder in a sample credentials file.
- Development error pages are enabled only in the local environment.
- A route exists in `routes.rb` but its engine is not mounted in the deployed application.

Tie route, before-action, policy scope, strong parameters, and model behavior together. Never invoke Rails console, jobs, or migrations against live data.
