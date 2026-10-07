import type { ScreenId } from "@agile-emr/shared";
import type { ComponentType } from "react";
import { AcceptInvitePage, ForgotPasswordPage, ResetPasswordPage } from "@/features/auth/Passwords";
import { MfaChallengePage } from "@/features/auth/MfaChallenge";
import { MfaEnrollPage } from "@/features/auth/MfaEnroll";
import { SignInPage } from "@/features/auth/SignIn";
import { AccountSecurityPage } from "@/features/auth/AccountSecurity";
import { PatientSearchPage } from "@/features/patients/PatientSearch";
import { RegistrationPage } from "@/features/patients/Registration";
import { MergeReviewPage } from "@/features/patients/MergeReview";
import { UsersRolesPage } from "@/features/admin/UsersRoles";
import { SecurityPolicyPage } from "@/features/admin/SecurityPolicy";
import { AuditLogPage } from "@/features/admin/AuditLog";
import { FrontDeskBoardPage } from "@/features/home/FrontDeskBoard";
import { CalendarPage } from "@/features/schedule/Calendar";
import { FlowBoardPage } from "@/features/schedule/FlowBoard";
import { RoomBoardPage } from "@/features/schedule/RoomBoard";
import { WaitlistPage } from "@/features/schedule/Waitlist";
import { RecallListPage } from "@/features/schedule/Recalls";
import { DemographicsPage } from "@/features/chart/Demographics";

/** Built screens by spec id. Anything not listed is hidden from navigation (NAV-09). */
export const publicScreens: Partial<Record<ScreenId, ComponentType>> = {
  "auth.sign-in": SignInPage,
  "auth.mfa-challenge": MfaChallengePage,
  "auth.mfa-enroll": MfaEnrollPage,
  "auth.forgot-password": ForgotPasswordPage,
  "auth.reset-password": ResetPasswordPage,
  "auth.accept-invite": AcceptInvitePage,
};

export const staffScreens: Partial<Record<ScreenId, ComponentType>> = {
  "auth.account-security": AccountSecurityPage,
  "patients.search": PatientSearchPage,
  "patients.registration": RegistrationPage,
  "patients.merge-review": MergeReviewPage,
  "admin.users-roles": UsersRolesPage,
  "admin.security": SecurityPolicyPage,
  "admin.audit-log": AuditLogPage,
  "home.frontdesk-board": FrontDeskBoardPage,
  "schedule.calendar": CalendarPage,
  "schedule.booking-drawer": CalendarPage,
  "schedule.appointment-detail": CalendarPage,
  "schedule.flow-board": FlowBoardPage,
  "schedule.room-board": RoomBoardPage,
  "schedule.waitlist": WaitlistPage,
  "schedule.recall-list": RecallListPage,
  "chart.demographics": DemographicsPage,
};
