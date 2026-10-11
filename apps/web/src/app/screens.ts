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
import { InterfacesPage } from "@/features/admin/Interfaces";
import { FrontDeskBoardPage } from "@/features/home/FrontDeskBoard";
import { CalendarPage } from "@/features/schedule/Calendar";
import { FlowBoardPage } from "@/features/schedule/FlowBoard";
import { RoomBoardPage } from "@/features/schedule/RoomBoard";
import { WaitlistPage } from "@/features/schedule/Waitlist";
import { RecallListPage } from "@/features/schedule/Recalls";
import { DemographicsPage } from "@/features/chart/Demographics";
import { ChartSummaryPage } from "@/features/chart/ChartSummary";
import { ProblemsPage } from "@/features/chart/Problems";
import { MedicationsPage } from "@/features/chart/Medications";
import { AllergiesPage } from "@/features/chart/Allergies";
import { VitalsPage } from "@/features/chart/Vitals";
import { ResultsPage } from "@/features/chart/Results";
import { OrdersListPage } from "@/features/chart/Orders";
import { TimelinePage } from "@/features/chart/Timeline";
import { PrechartPage } from "@/features/encounter/PrechartPage";
import { RoomingPage } from "@/features/encounter/rooming/RoomingPage";
import { NotePage } from "@/features/encounter/NotePage";
import { OrdersPage } from "@/features/encounter/orders/OrdersPage";
import { DxCodingPage } from "@/features/encounter/DxCodingPage";
import { AvsPage } from "@/features/encounter/AvsPage";
import { SignPage } from "@/features/encounter/SignPage";
import { ClinicalDayListPage } from "@/features/home/ClinicalDayList";
import { ProviderWorklistPage } from "@/features/home/ProviderWorklist";
import { CheckoutPage } from "@/features/schedule/Checkout";
import { CosignInboxPage } from "@/features/inbox/CosignInbox";
import { ResultsInboxPage } from "@/features/inbox/ResultsInbox";
import { RxRequestsInboxPage } from "@/features/inbox/RxRequestsInbox";
import { RxPage } from "@/features/encounter/rx/RxPage";
import { CollectionPage } from "@/features/orders/Collection";
import { ResultReconciliationPage } from "@/features/orders/ResultReconciliation";
import { TrackingPage } from "@/features/orders/Tracking";
import { ChargesPage } from "@/features/encounter/ChargesPage";
import { ChargeReviewPage } from "@/features/billing/ChargeReview";
import { ClaimsPage } from "@/features/billing/Claims";
import { RejectionsPage } from "@/features/billing/Rejections";
import { EraPostingPage } from "@/features/billing/EraPosting";
import { DenialsPage } from "@/features/billing/Denials";
import { PatientAccountPage } from "@/features/billing/PatientAccount";
import { StatementsPage } from "@/features/billing/Statements";
import { DayClosePage } from "@/features/billing/DayClose";

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
  "admin.interfaces": InterfacesPage,
  "home.frontdesk-board": FrontDeskBoardPage,
  "schedule.calendar": CalendarPage,
  "schedule.booking-drawer": CalendarPage,
  "schedule.appointment-detail": CalendarPage,
  "schedule.flow-board": FlowBoardPage,
  "schedule.room-board": RoomBoardPage,
  "schedule.waitlist": WaitlistPage,
  "schedule.recall-list": RecallListPage,
  "chart.demographics": DemographicsPage,
  "chart.summary": ChartSummaryPage,
  "chart.timeline": TimelinePage,
  "chart.problems": ProblemsPage,
  "chart.medications": MedicationsPage,
  "chart.allergies": AllergiesPage,
  "chart.vitals": VitalsPage,
  "chart.results": ResultsPage,
  "chart.orders": OrdersListPage,
  "encounter.prechart": PrechartPage,
  "encounter.rooming": RoomingPage,
  "encounter.note": NotePage,
  "encounter.orders": OrdersPage,
  "encounter.rx": RxPage,
  "encounter.dx-coding": DxCodingPage,
  "encounter.avs": AvsPage,
  "encounter.sign": SignPage,
  "home.clinical-daylist": ClinicalDayListPage,
  "home.provider-worklist": ProviderWorklistPage,
  "schedule.checkout": CheckoutPage,
  "inbox.cosign": CosignInboxPage,
  "inbox.results": ResultsInboxPage,
  "inbox.rx-requests": RxRequestsInboxPage,
  "orders.collection": CollectionPage,
  "orders.result-reconciliation": ResultReconciliationPage,
  "orders.tracking": TrackingPage,
  "encounter.charges": ChargesPage,
  "billing.charge-review": ChargeReviewPage,
  "billing.claims": ClaimsPage,
  "billing.rejections": RejectionsPage,
  "billing.era-posting": EraPostingPage,
  "billing.denials": DenialsPage,
  "billing.patient-account": PatientAccountPage,
  "billing.statements": StatementsPage,
  "billing.day-close": DayClosePage,
};
