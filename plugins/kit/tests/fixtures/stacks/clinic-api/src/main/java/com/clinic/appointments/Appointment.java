package com.clinic.appointments;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import java.time.Instant;

/** One patient visit with one clinician. A diagnosis is never stored here. */
@Entity
public class Appointment {
    @Id
    private Long id;
    private Long patientId;
    private Long clinicianId;
    private Instant startsAt;
    private String status; // BOOKED, CHECKED_IN, CANCELLED, NO_SHOW
}
