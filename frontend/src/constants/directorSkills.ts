/**
 * `/` 斜杠导演技能词典（双入口 Skill Hub：供 ChatDock 对话框与节点 Prompt 输入栏共同唤起）。
 */

export type DirectorSkillAction =
  | { kind: "open_director_stage"; tab: "script" | "remake" }
  | { kind: "insert_template"; snippet: string; preferredChatPrompt: string };

export interface DirectorSkillEntry {
  id: string;
  slash: string;
  title: string;
  badge: string;
  desc: string;
  action: DirectorSkillAction;
}

export const DIRECTOR_SKILLS: readonly DirectorSkillEntry[] = [
  {
    id: "script_breakdown",
    slash: "/剧本拆分镜",
    title: "AI 剧本拆分镜铺流",
    badge: "导演台",
    desc: "输入故事或商品脚本文案，AI 自动拆解主体设定与多镜连贯工作流并预览确认",
    action: { kind: "open_director_stage", tab: "script" },
  },
  {
    id: "video_remake",
    slash: "/爆款拉片复刻",
    title: "参考视频抽帧拉片复刻",
    badge: "导演台",
    desc: "上传本地参考短视频，自动抽关键帧并搭建「原片分镜 → 替换主角 → 复刻视频」节点流",
    action: { kind: "open_director_stage", tab: "remake" },
  },
  {
    id: "multicam_grid",
    slash: "/多机位九宫格",
    title: "同场多机位 3×3 九宫格",
    badge: "分镜模板",
    desc: "锁定同一人物造型与光线环境，同步拍出 9 个电影景别机位并支持一键切分",
    action: {
      kind: "insert_template",
      snippet: "严格锁定主角五官服饰与场景光源一致，生成 3×3 九宫格同场多机位联系表（远景、中景、正面特写、侧45°、过肩反打、低仰拍、高俯拍、手部细节、氛围背影）",
      preferredChatPrompt: "请帮我创建一个同场多机位 3×3 故事板节点，围绕选中主体生成九种不同电影景别的连贯镜头。",
    },
  },
  {
    id: "scene_next",
    slash: "/剧情推演",
    title: "连续动作推演下一幕",
    badge: "分镜模板",
    desc: "沿着当前引用画面推进 3 秒后的戏剧性动作与微表情变化",
    action: {
      kind: "insert_template",
      snippet: "严格延续参考图主角身份、服化道与一致环境光线，推演 3 秒后的下一幕戏剧性动作推进，35mm 电影胶片实拍质感",
      preferredChatPrompt: "请基于当前选中画布节点创建下游图片节点并连线，推演 3 秒后的下一幕连续画面并生成图片。",
    },
  },
  {
    id: "cinematic_light",
    slash: "/电影级打光",
    title: "电影级重打光氛围锁定",
    badge: "影棚精修",
    desc: "保留主体与构图不变，注入伦勃朗侧光、体积圣光或冷暖轮廓光层次",
    action: {
      kind: "insert_template",
      snippet: "电影级戏剧光影重塑，主光配合细腻发丝高光轮廓光与丁达尔体积光束，高动态范围光影过渡，皮肤与材质细节清晰锐利",
      preferredChatPrompt: "请为当前选中的画布节点设计一套电影级重打光改造提示词，并创建一个对照节点进行生成。",
    },
  },
] as const;

export function filterDirectorSkills(queryAfterSlash: string): DirectorSkillEntry[] {
  const q = queryAfterSlash.trim().toLowerCase();
  if (!q) return [...DIRECTOR_SKILLS];
  return DIRECTOR_SKILLS.filter(
    (s) =>
      s.slash.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.desc.toLowerCase().includes(q),
  );
}
