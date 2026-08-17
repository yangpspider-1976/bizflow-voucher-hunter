import { FormSkeleton } from "../../../_components/FormSkeleton";
import { formSkeletons } from "../../../_components/formSkeletons";

export default function Loading() {
  return <FormSkeleton cards={formSkeletons.editCampaign} />;
}
