"use client";
/** Register of selectable course icons + tones. Keys are what gets stored in
 *  courses/<slug>/course.json ({ icon }) via the course config API. */
import {
  AcademicCapIcon,
  BeakerIcon,
  BookOpenIcon,
  BriefcaseIcon,
  ChatBubbleLeftRightIcon,
  CircleStackIcon,
  CloudIcon,
  CodeBracketIcon,
  FolderIcon,
  LightBulbIcon,
  PresentationChartBarIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";

export type CourseIconKey =
  | "academic" | "book" | "beaker" | "briefcase" | "chat"
  | "code" | "database" | "folder" | "lightbulb" | "cloud"
  | "shield" | "square" | "chart";

type Tone = "emerald" | "indigo" | "cyan" | "neutral" | "red";

export interface CourseIconDef {
  key: CourseIconKey;
  label: string;
  Icon: ComponentType<{ className?: string; style?: React.CSSProperties }>;
  tone: Tone;
}

export const COURSE_ICONS: CourseIconDef[] = [
  { key: "academic", label: "Academic cap", Icon: AcademicCapIcon, tone: "indigo" },
  { key: "book", label: "Book", Icon: BookOpenIcon, tone: "cyan" },
  { key: "briefcase", label: "Briefcase", Icon: BriefcaseIcon, tone: "emerald" },
  { key: "beaker", label: "Beaker", Icon: BeakerIcon, tone: "cyan" },
  { key: "chart", label: "Chart", Icon: PresentationChartBarIcon, tone: "indigo" },
  { key: "chat", label: "Chat", Icon: ChatBubbleLeftRightIcon, tone: "emerald" },
  { key: "cloud", label: "Cloud", Icon: CloudIcon, tone: "cyan" },
  { key: "code", label: "Code", Icon: CodeBracketIcon, tone: "neutral" },
  { key: "database", label: "Database", Icon: CircleStackIcon, tone: "indigo" },
  { key: "folder", label: "Folder", Icon: FolderIcon, tone: "neutral" },
  { key: "lightbulb", label: "Lightbulb", Icon: LightBulbIcon, tone: "emerald" },
  { key: "shield", label: "Shield", Icon: ShieldCheckIcon, tone: "red" },
  { key: "square", label: "Grid", Icon: Squares2X2Icon, tone: "neutral" },
];

/** resolve a stored icon key — null/unknown falls back to the caller's cycle */
export function courseIconOf(key: string | null | undefined): CourseIconDef | null {
  return COURSE_ICONS.find((i) => i.key === key) ?? null;
}