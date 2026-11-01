import { questProgress, type QuestProgressValue } from "$aruna/resources/client";

export function watchQuests(render: (value: QuestProgressValue) => void) {
  return questProgress.subscribe(render);
}
