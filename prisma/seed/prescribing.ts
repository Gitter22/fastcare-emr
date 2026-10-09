/**
 * Prescribing seed (S4): a small pharmacy directory (fictional network entries, practiceId null), EPCS set-up for
 * Dr. Rao (identity proofing date, a demo DEA registration for schedules II-V), and preferred pharmacies for the demo
 * patients. Idempotent: pharmacies upsert by NCPDP id; DEA registration is created once.
 * NCPDP ids and the DEA number are demo values, not real registrations.
 */
import type { PrismaClient } from "../../generated/prisma-client/index.js";
import { encryptField } from "../../apps/api/src/encryption.js";

export const DEMO_PHARMACIES = [
  {
    ncpdpId: "9900011",
    name: "Riverbend Pharmacy",
    address: { addressLine1: "120 Main St", city: "Springfield", state: "IL", postalCode: "62701" },
    phone: "217-555-0141",
    fax: "217-555-0142",
    specialties: ["retail"],
    epcsEnabled: true,
  },
  {
    ncpdpId: "9900012",
    name: "Main Street Drug",
    address: { addressLine1: "45 Main St", city: "Springfield", state: "IL", postalCode: "62702" },
    phone: "217-555-0151",
    fax: "217-555-0152",
    specialties: ["retail"],
    epcsEnabled: true,
  },
  {
    ncpdpId: "9900013",
    name: "Lakeside Community Pharmacy",
    address: { addressLine1: "8 Lake Rd", city: "Chatham", state: "IL", postalCode: "62629" },
    phone: "217-555-0161",
    fax: null,
    specialties: ["retail"],
    epcsEnabled: false,
  },
  {
    ncpdpId: "9900014",
    name: "MailRx Home Delivery",
    address: {
      addressLine1: "1 Fulfillment Way",
      city: "Peoria",
      state: "IL",
      postalCode: "61602",
    },
    phone: "800-555-0171",
    fax: null,
    specialties: ["mail-order"],
    epcsEnabled: true,
  },
];

export async function seedPrescribing(prisma: PrismaClient, practiceId: string) {
  for (const p of DEMO_PHARMACIES)
    await prisma.pharmacy.upsert({
      where: { ncpdpId: p.ncpdpId },
      create: { ...p, practiceId: null },
      update: { name: p.name, address: p.address, epcsEnabled: p.epcsEnabled },
    });
  const preferred = await prisma.pharmacy.findUniqueOrThrow({ where: { ncpdpId: "9900011" } });

  // EPCS: only the MD; the NP is not set up, so canSign.controlledSubstances differs between them.
  const md = await prisma.practitioner.findFirst({ where: { practiceId, credential: "MD" } });
  if (md) {
    await prisma.practitioner.update({
      where: { id: md.id },
      data: {
        epcsEnabled: true,
        epcsProofedAt: md.epcsProofedAt ?? new Date("2026-01-15T00:00:00Z"),
      },
    });
    if (!(await prisma.deaRegistration.findFirst({ where: { practitionerId: md.id } })))
      await prisma.deaRegistration.create({
        data: {
          practiceId,
          practitionerId: md.id,
          number: encryptField("BR1234563"),
          state: "IL",
          schedules: ["2", "2N", "3", "3N", "4", "5"],
          expiresOn: new Date("2028-06-30"),
        },
      });
  }

  await prisma.patient.updateMany({
    where: { practiceId, preferredPharmacyId: null, mergedIntoId: null },
    data: { preferredPharmacyId: preferred.id },
  });
}
