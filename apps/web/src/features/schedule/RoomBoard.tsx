import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAuth, useMe } from "@/app/auth";
import { isBuilt } from "@/app/registry";
import { pathTo, tid } from "@/app/routes";
import { errorMessage } from "@/lib/api/client";
import { useApi, useApiMutation } from "@/lib/api/hooks";
import { relativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/layout";
import { Tag } from "@/components/ui/tag";
import { SubNav } from "@/shell/patterns";
import { Pressable } from "@/components/ui/pressable";

const S = "schedule.room-board";
const STATUS_TEXT = {
  READY: "Free",
  OCCUPIED: "Occupied",
  NEEDS_CLEANING: "Needs cleaning",
  OUT_OF_SERVICE: "Out of service",
} as const;

/** schedule.room-board: rooms with occupant, status and time. */
export function RoomBoardPage() {
  const me = useMe();
  const { can } = useAuth();
  const navigate = useNavigate();
  const board = useApi(
    "getRoomBoard",
    { query: me.activeLocationId ? { locationId: me.activeLocationId } : {} },
    { refetchInterval: 20_000 },
  );
  const update = useApiMutation("updateRoom", {
    invalidates: ["getRoomBoard", "listRooms"],
    onSuccess: () => toast("Room marked ready."),
    onError: (e) => toast(errorMessage(e)),
  });
  const rooms = board.data?.rooms ?? [];
  return (
    <div className="grid content-start gap-6 p-8">
      <SubNav which="schedule" />
      <PageHeader title="Rooms" />
      {board.isLoading ? (
        <LoadingRows />
      ) : board.error ? (
        <ErrorState onRetry={() => void board.refetch()} />
      ) : !rooms.length ? (
        <EmptyState title="No rooms at this location" />
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {rooms.map(({ room, appointment, since }) => (
          <article
            key={room.id}
            className="grid content-start gap-3 bg-surface p-5"
            data-testid={tid(S, "room-card")}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-h3 text-ink">{room.name}</h2>
              <Tag
                tone={
                  room.status === "READY"
                    ? "active"
                    : room.status === "OCCUPIED"
                      ? "outline"
                      : "caution"
                }
                data-testid={tid(S, "room-status")}
              >
                {STATUS_TEXT[room.status]}
              </Tag>
            </div>
            {appointment ? (
              <div className="grid gap-0.5">
                {isBuilt("chart.summary") || isBuilt("chart.demographics") ? (
                  <Pressable
                    type="button"
                    className="text-left text-body font-semibold hover:underline"
                    onClick={() =>
                      navigate(
                        pathTo(isBuilt("chart.summary") ? "chart.summary" : "chart.demographics", {
                          patientId: appointment.patient.id,
                        }),
                      )
                    }
                    data-testid={tid(S, "room-occupant")}
                  >
                    {appointment.patient.name}
                  </Pressable>
                ) : (
                  <span className="font-semibold" data-testid={tid(S, "room-occupant")}>
                    {appointment.patient.name}
                  </span>
                )}
                <span className="text-small text-ink-2">
                  {appointment.practitioner.name} · {since ? `since ${relativeTime(since)}` : ""}
                </span>
              </div>
            ) : (
              <span className="text-small text-ink-2">
                {room.equipment.length ? room.equipment.join(", ") : "No equipment listed"}
              </span>
            )}
            {room.status === "NEEDS_CLEANING" && can("updateRoom") ? (
              <Button
                size="sm"
                className="justify-self-start"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ params: { roomId: room.id }, body: { status: "READY" } })
                }
                data-testid={tid(S, "room-mark-clean")}
              >
                Mark ready
              </Button>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}
