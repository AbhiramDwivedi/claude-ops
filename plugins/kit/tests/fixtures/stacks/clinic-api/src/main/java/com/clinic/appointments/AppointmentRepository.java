package com.clinic.appointments;

import java.time.Instant;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AppointmentRepository extends JpaRepository<Appointment, Long> {
    List<Appointment> findByClinicianIdAndStartsAtBetween(Long clinicianId, Instant from, Instant to);
}
